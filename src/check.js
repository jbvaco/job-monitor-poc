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

function looksLikeJobLink(link) {
  return /job|jobs|posting|jobdetails|viewjob/i.test(link);
}

function normalizeText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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

for (const client of clients) {
  try {
    console.log("Checking:", client.name);

    await page.goto(client.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(5000);

    // Extract anchor title + url
    const items = await page.$$eval("a", anchors =>
      anchors
        .map(a => ({
          title: (a.innerText || "").trim(),
          url: a.href
        }))
        .filter(x => x && x.url)
    );

    const jobItems = dedupeByUrl(
      items
        .map(x => ({
          title: normalizeText(x.title),
          url: x.url
        }))
        .filter(x => looksLikeJobLink(x.url))
    );

    if (!seen[client.name]) seen[client.name] = [];

    // Identify new jobs by URL only
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

  // Build HTML email with clickable job titles
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
