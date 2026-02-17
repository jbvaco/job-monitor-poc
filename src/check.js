import fs from "fs";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const clients = JSON.parse(fs.readFileSync("clients.json", "utf8"));
const SEEN_FILE = "seen.json";

let seen = {};
if (fs.existsSync(SEEN_FILE)) {
  seen = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.setDefaultNavigationTimeout(90000);
page.setDefaultTimeout(30000);

let alerts = [];

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
  const junk = [
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
  ];
  if (junk.includes(x)) return true;
  if (x.length < 4) return true;
  // Pure navigation-ish
  if (/^(about|careers|locations|faq|privacy|terms|contact)$/.test(x)) return true;
  return false;
}

function dedupeByUrl(items) {
  const seenUrls = new Set();
  const out = [];
  for (const it of items) {
    if (!it?.url) continue;
    if (seenUrls.has(it.url)) continue;
    seenUrls.add(it.url);
    out.push(it);
  }
  return out;
}

function jobKey(clientName, url) {
  return `${clientName}::${url}`;
}

async function collectJobsForClient(client) {
  const url = client.url;
  const lower = url.toLowerCase();

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(4000);

  // GREENHOUSE
  if (lower.includes("greenhouse.io")) {
    const jobs = await page.$$eval('a[href*="/jobs/"]', as =>
      as
        .map(a => ({
          title: (a.textContent || "").trim(),
          url: a.href
        }))
        .filter(x => /\/jobs\/\d+/.test(x.url))
    );

    return dedupeByUrl(
      jobs
        .map(j => ({ title: normalizeText(j.title), url: j.url }))
        .filter(j => !isJunkTitle(j.title))
    );
  }

  // WORKDAY (OneOncology links to wd1.myworkdayjobs.com)
  if (lower.includes("myworkdayjobs.com") || (await page.url()).toLowerCase().includes("myworkdayjobs.com")) {
    // Workday job detail URLs usually contain /job/
    const jobs = await page.$$eval('a[href*="/job/"]', as =>
      as.map(a => ({ title: (a.textContent || "").trim(), url: a.href }))
    );

    return dedupeByUrl(
      jobs
        .map(j => ({ title: normalizeText(j.title), url: j.url }))
        .filter(j => j.url.toLowerCase().includes("/job/"))
        .filter(j => !isJunkTitle(j.title))
    );
  }

  // DAYFORCE
  if (lower.includes("dayforcehcm.com")) {
    // Dayforce posting links commonly include "/Posting/" or "/JobPosting/"
    const jobs = await page.$$eval('a[href]', as =>
      as
        .map(a => ({
          title: (a.textContent || "").trim(),
          url: a.href
        }))
        .filter(x => /\/(Posting|JobPosting)\//i.test(x.url))
    );

    return dedupeByUrl(
      jobs
        .map(j => ({ title: normalizeText(j.title), url: j.url }))
        .filter(j => !isJunkTitle(j.title))
    );
  }

  // iCIMS
  if (lower.includes("icims.com")) {
    const jobs = await page.$$eval('a[href*="/jobs/"]', as =>
      as
        .map(a => ({ title: (a.textContent || "").trim(), url: a.href }))
        .filter(x => /\/jobs\/\d+/.test(x.url))
    );

    return dedupeByUrl(
      jobs
        .map(j => ({ title: normalizeText(j.title), url: j.url }))
        .filter(j => !isJunkTitle(j.title))
    );
  }

  // DELEK (Oracle-style). Often job results are links with /job/ in URL
  if (lower.includes("jobs.delekus.com")) {
    const jobs = await page.$$eval('a[href*="/job/"]', as =>
      as.map(a => ({ title: (a.textContent || "").trim(), url: a.href }))
    );

    return dedupeByUrl(
      jobs
        .map(j => ({ title: normalizeText(j.title), url: j.url }))
        .filter(j => j.url.toLowerCase().includes("/job/"))
        .filter(j => !isJunkTitle(j.title))
    );
  }

  // FALLBACK: generic, but filtered hard
  const jobs = await page.$$eval("a[href]", as =>
    as.map(a => ({ title: (a.textContent || "").trim(), url: a.href }))
  );

  return dedupeByUrl(
    jobs
      .map(j => ({ title: normalizeText(j.title), url: j.url }))
      .filter(j => !isJunkTitle(j.title))
      .filter(j => /job|jobs|posting|jobdetails|viewjob/i.test(j.url))
  );
}

for (const client of clients) {
  try {
    console.log("Checking:", client.name);

    const jobItems = await collectJobsForClient(client);

    if (!seen[client.name]) seen[client.name] = [];

    const newJobs = jobItems.filter(x => !seen[client.name].includes(x.url));

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
    continue;
  }
}

await browser.close();

if (alerts.length > 0) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  let html = `<div style="font-family: Arial, sans-serif; font-size: 14px;">`;
  html += `<p><b>New job postings detected</b></p>`;

  for (const alert of alerts) {
    html += `<p style="margin: 16px 0 6px 0;"><b>${escapeHtml(alert.name)}</b><br/>`;
    html += `<span>Careers: <a href="${escapeHtml(alert.url)}">${escapeHtml(alert.url)}</a></span></p>`;
    html += `<ul style="margin-top: 6px;">`;

    alert.jobs.slice(0, 25).forEach(job => {
      const title = job.title ? job.title : job.url;
      html += `<li><a href="${escapeHtml(job.url)}">${escapeHtml(title)}</a></li>`;
    });

    if (alert.jobs.length > 25) {
      html += `<li>(and ${alert.jobs.length - 25} more)</li>`;
    }

    html += `</ul>`;
  }

  html += `</div>`;

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: "New job postings detected",
    html
  });

  console.log("Email sent");
} else {
  console.log("No new jobs found.");
}

fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
