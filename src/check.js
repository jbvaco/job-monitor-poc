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

// Global timeouts (more forgiving)
page.setDefaultNavigationTimeout(90000); // 90s
page.setDefaultTimeout(30000);           // 30s for actions

let alerts = [];

function normalizeLinks(links) {
  return [...new Set((links || []).filter(Boolean))];
}

function looksLikeJobLink(link) {
  return /job|jobs|posting|jobdetails|viewjob/i.test(link);
}

for (const client of clients) {
  try {
    console.log("Checking:", client.name);

    // Use domcontentloaded instead of networkidle (networkidle can hang forever on JS apps)
    await page.goto(client.url, { waitUntil: "domcontentloaded", timeout: 90000 });

    // Give JS apps a moment to render listings
    await page.waitForTimeout(5000);

    const links = await page.$$eval("a", anchors =>
      anchors.map(a => a.href).filter(Boolean)
    );

    const jobLinks = normalizeLinks(links).filter(looksLikeJobLink);

    if (!seen[client.name]) seen[client.name] = [];

    const newJobs = jobLinks.filter(link => !seen[client.name].includes(link));

    if (newJobs.length > 0) {
      alerts.push({
        name: client.name,
        url: client.url,
        jobs: newJobs
      });
      seen[client.name].push(...newJobs);
    }
  } catch (err) {
    // Do NOT fail the whole run for one bad client
    console.log(`Error checking ${client.name}:`, err?.message || err);
    continue;
  }
}

await browser.close();

// Only email if we actually found new jobs
if (alerts.length > 0) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  let body = "";
  for (const alert of alerts) {
    body += `Client: ${alert.name}\nCareers: ${alert.url}\nNew:\n`;
    alert.jobs.slice(0, 25).forEach(job => {
      body += `- ${job}\n`;
    });
    body += "\n";
  }

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: "New job postings detected",
    text: body
  });

  console.log("Email sent");
} else {
  console.log("No new jobs found.");
}

fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
