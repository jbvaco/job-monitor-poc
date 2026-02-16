import fs from "fs";
import nodemailer from "nodemailer";
import { chromium } from "playwright";

const clients = JSON.parse(fs.readFileSync("clients.json", "utf8"));
const SEEN_FILE = "seen.json";

let seen = {};
if (fs.existsSync(SEEN_FILE)) {
  seen = JSON.parse(fs.readFileSync(SEEN_FILE));
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

let alerts = [];

for (const client of clients) {
  console.log("Checking:", client.name);
  await page.goto(client.url, { waitUntil: "networkidle" });

  const links = await page.$$eval("a", anchors =>
    anchors.map(a => a.href).filter(Boolean)
  );

  const jobLinks = links.filter(link =>
    link.match(/job|jobs|posting|jobdetails|viewjob/i)
  );

  if (!seen[client.name]) {
    seen[client.name] = [];
  }

  const newJobs = jobLinks.filter(link => !seen[client.name].includes(link));

  if (newJobs.length > 0) {
    alerts.push({
      name: client.name,
      url: client.url,
      jobs: newJobs
    });
    seen[client.name].push(...newJobs);
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

  let body = "";

  for (const alert of alerts) {
    body += `Client: ${alert.name}\nCareers: ${alert.url}\nNew:\n`;
    alert.jobs.slice(0, 25).forEach(job => {
      body += `- ${job}\n`;
    });
    body += "\n\n";
  }

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: process.env.EMAIL_TO,
    subject: "New job postings detected",
    text: body
  });

  console.log("Email sent");
}

fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
