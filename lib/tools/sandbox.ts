import type { Sandbox } from "@vercel/sandbox";

/**
 * Real code execution for attached data files (reconciling spreadsheets, computing real numbers
 * from an uploaded dataset) via Vercel Sandbox: an ephemeral VM the agent writes and runs actual
 * Python in, rather than eyeballing a pasted table. One sandbox is created per turn, reused across
 * every run_code call in that turn (so a pandas/openpyxl install only happens once); the sandbox's
 * network is locked to PyPI only, so the only way data gets in or out is the files this server
 * pushes in before the agent's code runs and the stdout/output files it reads back after.
 */

const TEAM_ID = process.env.VERCEL_SANDBOX_TEAM_ID || "team_G3ByzOzBzPYsVrk5KRLVrfpQ";
const PROJECT_ID = process.env.VERCEL_SANDBOX_PROJECT_ID || "prj_HMYvwd3RV7XeQ9LYxgBUi4XEQHq1";
const DATA_DIR = "/tmp/data";
const OUTPUT_DIR = "/tmp/output";
const SANDBOX_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_RUNS_PER_TURN = 10;
const MAX_OUTPUT_FILE_BYTES = 40_000;

export type DataFile = { name: string; url: string };

function sanitizeFilename(name: string) {
  return name.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-80) || "file";
}

function credentials() {
  const token = process.env.VERCEL_SANDBOX_TOKEN;
  if (!token) throw new Error("code execution isn't configured: VERCEL_SANDBOX_TOKEN is missing");
  return { token, teamId: TEAM_ID, projectId: PROJECT_ID };
}

export class CodeSandbox {
  private sandbox: Sandbox | null = null;
  private ready = false;
  private runs = 0;

  private async setup(dataFiles: DataFile[]) {
    if (this.ready) return;
    const creds = credentials();
    // Loaded only when run_code actually runs, so a problem with this package (or its undici dependency on an
    // older Node) can never take down a turn that has no spreadsheet attached.
    const { Sandbox } = await import("@vercel/sandbox").catch((e) => {
      throw new Error(`code execution isn't available: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.sandbox = await Sandbox.create({
      ...creds,
      persistent: false,
      timeout: SANDBOX_TIMEOUT_MS,
      resources: { vcpus: 2 },
      // The sandbox never needs to reach anything but PyPI: uploaded data is pushed in by this
      // server (writeFiles), never fetched by the sandboxed code, so there's no exfiltration route.
      networkPolicy: { allow: ["pypi.org", "files.pythonhosted.org"] },
    });
    await this.sandbox.mkDir(DATA_DIR);
    await this.sandbox.mkDir(OUTPUT_DIR);
    if (dataFiles.length) {
      const files: { path: string; content: Buffer }[] = [];
      for (const f of dataFiles) {
        const res = await fetch(f.url);
        if (!res.ok) continue;
        files.push({ path: `${DATA_DIR}/${sanitizeFilename(f.name)}`, content: Buffer.from(await res.arrayBuffer()) });
      }
      if (files.length) await this.sandbox.writeFiles(files);
    }
    const install = await this.sandbox.runCommand({
      cmd: "pip3",
      args: ["install", "--break-system-packages", "--quiet", "pandas", "openpyxl", "numpy"],
      timeoutMs: 120_000,
    });
    if (install.exitCode !== 0) {
      throw new Error(`setting up the Python environment failed:\n${(await install.stderr()).slice(0, 800)}`);
    }
    this.ready = true;
  }

  async run(args: { language?: "python" | "node"; code: string }, dataFiles: DataFile[]) {
    if (this.runs >= MAX_RUNS_PER_TURN) throw new Error(`that's this turn's code-execution limit (${MAX_RUNS_PER_TURN} runs); work with what you have`);
    this.runs += 1;
    await this.setup(dataFiles);
    const sandbox = this.sandbox!;
    const ext = args.language === "node" ? "js" : "py";
    const scriptPath = `/tmp/script.${ext}`;
    await sandbox.writeFiles([{ path: scriptPath, content: Buffer.from(String(args.code ?? ""), "utf8") }]);
    const r = await sandbox.runCommand({
      cmd: args.language === "node" ? "node" : "python3",
      args: [scriptPath],
      cwd: "/tmp",
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const [stdout, stderr] = await Promise.all([r.stdout(), r.stderr()]);

    const ls = await sandbox.runCommand({ cmd: "bash", args: ["-lc", `find ${OUTPUT_DIR} -maxdepth 1 -type f 2>/dev/null`], timeoutMs: 10_000 });
    const names = (await ls.stdout()).split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10);
    const outputFiles: { name: string; content: string }[] = [];
    for (const path of names) {
      const buf = await sandbox.readFileToBuffer({ path });
      if (buf) outputFiles.push({ name: path.split("/").pop()!, content: buf.subarray(0, MAX_OUTPUT_FILE_BYTES).toString("utf8") });
    }

    return { exitCode: r.exitCode, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 4_000), outputFiles };
  }

  /** Best-effort: lets the VM go rather than waiting out its full timeout. Never blocks the turn on failure. */
  async stop() {
    if (!this.sandbox) return;
    try {
      await this.sandbox.stop();
    } catch {
      // it'll stop on its own at SANDBOX_TIMEOUT_MS regardless
    }
  }
}

export const RUN_CODE_SCHEMA = {
  type: "function" as const,
  function: {
    name: "run_code",
    description:
      "Run real Python (pandas/openpyxl/numpy preinstalled) against the attached data file(s) in an isolated sandbox — for reconciling spreadsheets, computing real totals/diffs/matches, or anything needing actual computation rather than eyeballing a table. Attached files are already at /tmp/data/<name>; write any result file you want back (a reconciled sheet, a diff) to /tmp/output/ and it's returned to you. Print a JSON summary to stdout with the real numbers (counts, totals, mismatches) to put in the design. No internet access beyond installing Python packages.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "node"], description: 'Default "python" (pandas/openpyxl/numpy are preinstalled); "node" has no extra packages.' },
        code: { type: "string", description: "The full script to run." },
      },
      required: ["code"],
    },
  },
};
