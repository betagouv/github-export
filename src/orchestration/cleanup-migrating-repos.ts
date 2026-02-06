import puppeteer from "puppeteer";
import { CodebergClient } from "../api/codeberg-client.js";

async function checkIfMigrating(
  browser: puppeteer.Browser,
  url: string,
): Promise<boolean> {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const content = await page.content();
    // Check if page shows "migrating" indicator
    return content.toLowerCase().includes("migrating from...");
  } catch (error: any) {
    console.error(`  Failed to load ${url}: ${error.message}`);
    return false;
  } finally {
    await page.close();
  }
}

async function main() {
  const codebergToken = process.env.CODEBERG_TOKEN;
  const targetOrg = process.env.CODEBERG_TARGET_ORG;
  const dryRun = process.env.DRY_RUN === "true";

  if (!codebergToken || !targetOrg) {
    console.error("Missing required environment variables:");
    console.error("  CODEBERG_TOKEN, CODEBERG_TARGET_ORG");
    process.exit(1);
  }

  const client = new CodebergClient({
    token: codebergToken,
    org: targetOrg,
  });

  console.log(`Fetching repos from ${targetOrg}...`);
  const repos = await client.listOrgRepos();
  console.log(`Found ${repos.length} total repos\n`);

  console.log("Launching browser to check each repo page...\n");
  const browser = await puppeteer.launch({ headless: true });

  const migratingRepos: typeof repos = [];

  for (const repo of repos) {
    process.stdout.write(`Checking ${repo.name} (${repo.html_url})... `);
    const isMigrating = await checkIfMigrating(browser, repo.html_url);
    if (isMigrating) {
      console.log("MIGRATING");
      migratingRepos.push(repo);
    } else {
      console.log("ok");
    }
  }

  await browser.close();

  console.log();

  if (migratingRepos.length === 0) {
    console.log("No repos are currently in migrating state.");
    return;
  }

  console.log(`Found ${migratingRepos.length} repos in migrating state:`);
  for (const repo of migratingRepos) {
    console.log(`  - ${repo.name} (${repo.html_url})`);
  }
  console.log();

  if (dryRun) {
    console.log("DRY_RUN=true - No repos will be deleted.");
    return;
  }

  console.log("Deleting migrating repos...\n");
  let deleted = 0;
  let failed = 0;

  for (const repo of migratingRepos) {
    try {
      await client.deleteRepo(repo.name);
      console.log(`  ✓ Deleted ${repo.name}`);
      deleted++;
    } catch (error: any) {
      console.error(`  ✗ Failed to delete ${repo.name}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Deleted: ${deleted}`);
  console.log(`  Failed: ${failed}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
