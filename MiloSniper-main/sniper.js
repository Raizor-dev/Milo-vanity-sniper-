const https = require("https");
const { URL } = require("url");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

const TOKEN = process.env.DISCORD_TOKEN || "TOKEN_HERE";
const WEBHOOK_URL = process.env.WEBHOOK_URL || "WEBHOOK_URL";

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 30_000,
  keepAliveMsecs: 1_000,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJsonRequest(urlString, method, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(bodyObj);

    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      path: `${url.pathname}${url.search}`,
      method,
      agent,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        ...headers,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];

      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          text,
        });
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseRetryMs(responseText, responseHeaders) {
  const headerRetry = responseHeaders["retry-after"];
  if (headerRetry) {
    const seconds = Number(headerRetry);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  if (responseText) {
    try {
      const data = JSON.parse(responseText);
      const retryAfter = Number(data.retry_after);
      if (Number.isFinite(retryAfter) && retryAfter >= 0) {
        return Math.ceil(retryAfter * 1000);
      }
    } catch {
      // Ignore JSON parsing issues and use fallback below.
    }
  }

  return 1_000;
}

async function sendWebhook(content) {
  if (!WEBHOOK_URL || WEBHOOK_URL === "WEBHOOK_URL") {
    return;
  }

  try {
    await sendJsonRequest(WEBHOOK_URL, "POST", {}, { content });
  } catch {
    // Webhook failures should not block sniping loop.
  }
}

async function changeVanity(guildId, vanity, token) {
  const endpoint = `https://discord.com/api/v9/guilds/${guildId}/vanity-url`;

  try {
    const response = await sendJsonRequest(
      endpoint,
      "PATCH",
      { Authorization: token },
      { code: vanity }
    );

    if (response.status === 200) {
      console.log(`Vanity URL changed to '${vanity}' for guild '${guildId}'.`);
      await sendWebhook("@everyone Vanity changed successfully");
      return { ok: true, retryMs: 0 };
    }

    if (response.status === 429) {
      const retryMs = parseRetryMs(response.text, response.headers);
      return { ok: false, retryMs };
    }

    return { ok: false, retryMs: 250, error: response.text };
  } catch (error) {
    return { ok: false, retryMs: 250, error: error.message };
  }
}

async function main() {
  if (!TOKEN || TOKEN === "TOKEN_HERE") {
    console.error("Set DISCORD_TOKEN env var (or replace TOKEN_HERE).");
    process.exit(1);
  }

  const rl = readline.createInterface({ input, output });

  const guildId = (await rl.question("Enter the Guild ID: ")).trim();
  const vanity = (await rl.question("Enter the vanity: ")).trim();
  rl.close();

  if (!guildId || !vanity) {
    console.error("Guild ID and vanity are required.");
    process.exit(1);
  }

  while (true) {
    const result = await changeVanity(guildId, vanity, TOKEN);

    if (result.ok) {
      break;
    }

    if (result.error) {
      process.stdout.write(`\rLast error: ${String(result.error).slice(0, 120)}   `);
    }

    await sleep(result.retryMs || 5);
  }
}

main()
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  })
  .finally(() => {
    agent.destroy();
  });
