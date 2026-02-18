import fs from "fs";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const clients = JSON.parse(fs.readFileSync("clients.json", "utf8"));
const SEEN_FILE = "seen.json";

const DRY_RUN = String(process.env.DRY_RUN || "").toLowerCase() === "true";

let seen = {};
if (!DRY_RUN && fs.existsSync(SEEN_FILE)) {
  seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.setDefaultNavigationTimeout(90000);
page.setDefaultTimeout(30000);

let alerts = [];
let dryRunReport = [];

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function isJunkTitle(t) {
  const x = normalizeText(t).toLowerCase();
  if (!x) return true;

  const junkExact = new Set([
    "skip to content",
    "skip branding",
    "create alert",
    "sign in",
    "home",
    "reset",
    "title",
    "location",
    "department",
    "view all jobs",
    "see open positions",
    "see open open positions positions"
  ]);

  if (junkExact.has(x)) return true;
  if (x.length < 4) return true;
  if (/^(about|careers|locations|faq|privacy|terms|contact)$/i.test(x)) return true;

  return false;
}

function dedupeByUrl(items) {
  const seenUrls = new Set();
  const out = [];
  for (const it of items || []) {
    if (!it?.url) continue;
    if (seenUrls.has(it.url)) continue;
    seenUrls.add(it.url);
    out.push(it);
  }
  return out;
}

/**
 * Division classification (best guess).
 * Rule: NEVER drop jobs. Always return a division.
 */
function classifyDivision(title, url) {
  const t = (normalizeText(title) + " " + String(url || "")).toLowerCase();

  const tech = [
    "software", "engineer", "developer", "devops", "sre", "site reliability",
    "data", "analytics", "machine learning", "ml", "ai", "cloud", "aws", "azure", "gcp",
    "security", "cyber", "infosec", "network", "systems", "infrastructure",
    "it ", " it-", "help desk", "helpdesk", "service desk", "servicedesk",
    "qa", "test ", "testing", "automation", "product manager", "product management",
    "solutions engineer", "integration", "implementation", "salesforce", "sap", "oracle",
    "sql", "python", "java", "javascript", "react", "node", "kubernetes", "docker",
    "architect", "platform", "mobile", "ios", "android"
  ];

  const finance = [
    "accounting", "accountant", "finance", "financial", "fp&a", "fpa",
    "controller", "controllership", "cpa", "audit", "auditor",
    "tax", "treasury", "payroll", "ap ", "a/p", "accounts payable",
    "ar ", "a/r", "accounts receivable", "billing", "credit", "collections",
    "bookkeeper", "bookkeeping", "cost accountant", "revenue", "budget", "forecast",
    "procurement", "purchasing", "p2p", "r2r"
  ];

  const general = [
    "operations", "operator", "warehouse", "manufacturing", "plant",
    "production", "logistics", "driver", "terminal", "maintenance", "technician",
    "field", "safety", "health & safety", "hse", "hr ", "human resources",
    "recruiter", "recruiting", "coordinator", "assistant", "admin",
    "customer service", "csr", "sales", "account manager", "marketing",
    "manager", "supervisor", "specialist", "analyst"
  ];

  const score = (keywords) => keywords.reduce((acc, k) => acc + (t.includes(k) ? 1 : 0), 0);

  const sTech = score(tech);
  const sFin = score(finance);
  const sGen = score(general);

  if (sTech > sFin && sTech > sGen) return "Technology";
  if (sFin > sTech && sFin > sGen) return "Finance";
  if (sGen > 0) return "General Staffing";

  return "Uncategorized";
}

async function collectJobsForClient(client) {
  const startUrl = client.url;
  const lower = (startUrl || "").toLowerCase();

  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);

  // GREENHOUSE
  if (lower.includes("greenhouse.io")) {
    const jobs = await page.$$eval('a[href*="/jobs/"]', as =>
      as
        .map(a => ({ title: (a.innerText || "").trim(), url: a.href }))
        .filter(x => /\/jobs\/\d+/.test(x.url))
    );

    return dedupeByUrl(
      jobs
        .map(j => ({ title: normalizeText(j.title), url: j.url }))
        .filter(j => !isJunkTitle(j.title))
    );
  }

  // WORKDAY (handles OneOncology-style hub pages)
  if (
    lower.includes("myworkdayjobs.com") ||
    (await page.url()).toLowerCase().includes("myworkdayjobs.com") ||
    lower.includes("oneoncology.com")
  ) {
    const tenantRoots = await page.$$eval('a[href*="myworkdayjobs.com/"]', as => {
      const roots = as
        .map(a => (a.href || "").trim())
        .filter(Boolean)
        .map(h => h.replace(/\/job\/.*$/i, ""))
        .map(h => h.replace(/\/$/, ""));
      return Array.from(new Set(roots));
    });

    const current = (await page.url()).replace(/\/job\/.*$/i, "").replace(/\/$/, "");
    if (current.toLowerCase().includes("myworkdayjobs.com/") && !tenantRoots.includes(current)) {
      tenantRoots.push(current);
    }

    const allJobs = [];
    for (const root of tenantRoots) {
      try {
        await page.goto(root, { waitUntil: "domcontentloaded", timeout: 90000 });
        await page.waitForTimeout(4000);

        const jobs = await page.$$eval('a[href*="/job/"]', as =>
          as.map(a => ({ title: (a.innerText || "").trim(), url: a.href }))
        );

        const cleaned = jobs
          .map(j => ({ title: normalizeText(j.title), url: j.url }))
          .filter(j => j.url.toLowerCase().includes("/job/"))
          .filter(j => !isJunkTitle(j.title));

        allJobs.push(...cleaned);
      } catch (e) {
        console.log("Workday tenant failed:", root, e?.message || e);
      }
    }

    return dedupeByUrl(allJobs);
  }

  // DAYFORCE
  if (lower.includes("dayforcehcm.com")) {
    const items = await page.$$eval("a[href]", as =>
      as.map(a => ({ title: (a.innerText || "").trim(), url: a.href }))
    );

    const filtered = items
      .map(j => ({ title: normalizeText(j.title), url: j.url }))
      .filter(j => /dayforcehcm\.com/i.test(j.url))
      .filter(j =>
        /\/candidateportal\/jobs\/\d+/i.test(j.url) ||
        /\/jobs\/\d+/i.test(j.url) ||
        /\/(posting|jobposting)\//i.test(j.url)
      )
      .filter(j => !isJunkTitle(j.title));

    return dedupeByUrl(filtered);
  }

  // iCIMS
  if (lower.includes("icims.com")) {
    try {
      const searchBtn = page.getByRole("button", { name: /search/i });
      if ((await searchBtn.count()) > 0) {
        await searchBtn.first().click({ timeout: 5000 });
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      // ignore
    }

    const jobs = await page.$$eval('a[href*="/jobs/"]', as =>
      as
        .map(a => ({ title: (a.innerText || "").trim(), url: a.href }))
        .filter(x => /\/jobs\/\d+/.test(x.url))
    );

    return dedupeByUrl(
      jobs
        .map(j => ({ title: normalizeText(j.title), url: j.url }))
        .filter(j => !isJunkTitle(j.title))
    );
  }

  // DELEK
  if (lower.includes("jobs.delekus.com")) {
    const jobs = await page.$$eval('a[href*="/job/"]', as =>
      as.map(a => ({ title: (a.innerText || "").trim(), url: a.href }))
    );

    return dedupeByUrl(
      jobs
        .map(j => ({ title: normalizeText(j.title), url: j.url }))
        .filter(j => j.url.toLowerCase().includes("/job/"))
        .filter(j => !isJunkTitle(j.title))
    );
  }

  // FALLBACK (strict)
  const items = await page.$$eval("a[href]", as =>
    as.map(a => ({ title: (a.innerText || "").trim(), url: a.href }))
  );

  const filtered = items
    .map(j => ({ title: normalizeText(j.title), url: j.url }))
    .filter(j => !isJunkTitle(j.title))
    .filter(j => /job|jobs|posting|jobdetails|viewjob/i.test(j.url));

  return dedupeByUrl(filtered);
}

function printDryRunSummary(name, url, jobs) {
  console.log("\n========== DRY RUN ==========");
  console.log(`Client: ${name}`);
  console.log(`Careers: ${url}`);
  console.log(`Detected jobs: ${jobs.length}`);

  jobs.slice(0, 10).forEach((j, idx) => {
    const title = j.title || "(no title)";
    const div = j.division || "Uncategorized";
    console.log(`${idx + 1}. [${div}] ${title} | ${j.url}`);
  });

  if (jobs.length > 10) {
    console.log(`... and ${jobs.length - 10} more`);
  }
  console.log("========== END DRY RUN ==========\n");
}

for (const client of clients) {
  try {
    console.log("Checking:", client.name);

    const jobItems = await collectJobsForClient(client);

    const enriched = jobItems.map(j => ({
      title: j.title,
      url: j.url,
      division: classifyDivision(j.title, j.url)
    }));

    if (DRY_RUN) {
      printDryRunSummary(client.name, client.url, enriched);
      dryRunReport.push({ client: client.name, url: client.url, count: enriched.length });
      continue;
    }

    if (!seen[client.name]) seen[client.name] = [];
    const newJobs = enriched.filter(x => !seen[client.name].includes(x.url));

    if (newJobs.length > 0) {
      alerts.push({
        name: client.name,
        url: client.url,
        jobs: newJobs
      });
      seen[client.name].push(...newJobs.map(x => x.url));
    }
  } catch (err) {
    console.log(`Error checking ${client.name}:`, err?.message || err);
    if (DRY_RUN) {
      printDryRunSummary(client.name, client.url, []);
    }
    continue;
  }
}

await browser.close();

if (DRY_RUN) {
  console.log("DRY RUN complete. No email sent. seen.json unchanged.");
} else if (alerts.length > 0) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  let html = `<div style="font-family: Arial, sans-serif; font-size: 14px;">`;
  html += `<p><b>New job postings detected</b></p>`;

  const divisionOrder = ["Technology", "Finance", "General Staffing", "Uncategorized"];

  for (const alert of alerts) {
    html += `<p style="margin: 16px 0 6px 0;"><b>${escapeHtml(alert.name)}</b><br/>`;
    html += `<span>Careers: <a href="${escapeHtml(alert.url)}">${escapeHtml(alert.url)}</a></span></p>`;

    const byDiv = {};
    for (const d of divisionOrder) byDiv[d] = [];
    for (const job of alert.jobs) {
      const d = job.division || "Uncategorized";
      if (!byDiv[d]) byDiv[d] = [];
      byDiv[d].push(job);
    }

    for (const d of divisionOrder) {
      const list = byDiv[d] || [];
      if (list.length === 0) continue;

      html += `<div style="margin: 8px 0 2px 0;"><b>${escapeHtml(d)}</b></div>`;
      html += `<ul style="margin-top: 6px;">`;

      list.slice(0, 25).forEach(job => {
        const title = job.title ? job.title : job.url;
        html += `<li><a href="${escapeHtml(job.url)}">${escapeHtml(title)}</a></li>`;
      });

      if (list.length > 25) {
        html += `<li>(and ${list.length - 25} more)</li>`;
      }

      html += `</ul>`;
    }
  }

  html += `</div>`;

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: "New job postings detected",
    html
  });

  console.log("Email sent");

  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
} else {
  console.log("No new jobs found.");
  fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}
