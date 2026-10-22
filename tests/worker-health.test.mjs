import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([
  [200, 'sosyal_itibar_worker_stale{job="process-videos"} 0\nsosyal_itibar_worker_stale{job="process-analyses"} 0\n', 0],
  [200, 'sosyal_itibar_worker_stale{job="process-videos"} 1\n', 1],
  [200, '# No heartbeat metrics\n', 1],
  [401, 'unauthorized', 1],
])("checks protected heartbeat metrics: HTTP %s", async (status, body, expected) => {
  let auth;
  const server = createServer((req, res) => { auth = req.headers.authorization; res.writeHead(status); res.end(body); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await new Promise(resolve => execFile(process.execPath,
      [fileURLToPath(new URL("../scripts/check-worker.mjs", import.meta.url))],
      { env: { ...process.env, CRON_SECRET: "fixture-secret", APP_INTERNAL_URL: `http://127.0.0.1:${server.address().port}` } },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr })));
    expect(result.code).toBe(expected); expect(auth).toBe("Bearer fixture-secret");
    expect(result.output).not.toContain("fixture-secret");
  } finally { await new Promise(resolve => server.close(resolve)); }
});
