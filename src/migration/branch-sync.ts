import { simpleGit, SimpleGit } from "simple-git";
import { mkdir, rm } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import pRetry from "p-retry";

export interface BranchSyncOptions {
  sourceUrl: string;
  targetUrl: string;
  sourceToken?: string;
  targetToken?: string;
  workDir?: string;
}

export interface BranchSyncResult {
  success: boolean;
  branchesProcessed: number;
  error?: string;
}

function injectToken(url: string, token?: string): string {
  if (!token) return url;

  // For HTTPS URLs, inject token
  if (url.startsWith("https://")) {
    const urlObj = new URL(url);
    urlObj.username = token;
    urlObj.password = "x-oauth-basic";
    return urlObj.toString();
  }
  return url;
}

export async function syncBranches(
  options: BranchSyncOptions
): Promise<BranchSyncResult> {
  const { sourceUrl, targetUrl, sourceToken, targetToken, workDir = "/tmp" } = options;

  const repoName = sourceUrl.split("/").pop()?.replace(".git", "") ?? "repo";
  const localPath = join(workDir, `clone-${repoName}-${Date.now()}`);

  console.log(`Starting branch sync for ${repoName}`);
  console.log(`Source: ${sourceUrl}`);
  console.log(`Target: ${targetUrl.replace(/:[^@]+@/, ":***@")}`);

  const git: SimpleGit = simpleGit();

  try {
    // Clean up any existing directory
    if (existsSync(localPath)) {
      await rm(localPath, { recursive: true, force: true });
    }
    await mkdir(localPath, { recursive: true });

    // Clone with mirror flag to get all branches and tags
    const sourceWithToken = injectToken(sourceUrl, sourceToken);
    const targetWithToken = injectToken(targetUrl, targetToken);

    console.log("Cloning source repository (mirror)...");
    await pRetry(
      async () => {
        await git.clone(sourceWithToken, localPath, ["--mirror"]);
      },
      {
        retries: 3,
        onFailedAttempt: (error) => {
          console.warn(`Clone attempt ${error.attemptNumber} failed: ${error.message}`);
        },
      }
    );

    const repoGit = simpleGit(localPath);

    // Get list of branches
    const branchResult = await repoGit.branch(["-a"]);
    const branchCount = branchResult.all.length;
    console.log(`Found ${branchCount} branches/refs`);

    // Set target remote
    console.log("Setting target remote...");
    try {
      await repoGit.remote(["remove", "origin"]);
    } catch {
      // Ignore if remote doesn't exist
    }
    await repoGit.remote(["add", "origin", targetWithToken]);

    // Force push mirror to target
    console.log("Force pushing to target (mirror)...");
    await pRetry(
      async () => {
        await repoGit.push(["--mirror", "--force", "origin"]);
      },
      {
        retries: 3,
        onFailedAttempt: (error) => {
          console.warn(`Push attempt ${error.attemptNumber} failed: ${error.message}`);
        },
      }
    );

    console.log(`Successfully synced ${branchCount} refs to target`);

    return {
      success: true,
      branchesProcessed: branchCount,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`Branch sync failed: ${errorMessage}`);

    return {
      success: false,
      branchesProcessed: 0,
      error: errorMessage,
    };
  } finally {
    // Cleanup
    try {
      if (existsSync(localPath)) {
        await rm(localPath, { recursive: true, force: true });
      }
    } catch {
      console.warn(`Failed to cleanup ${localPath}`);
    }
  }
}
