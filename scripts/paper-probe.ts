import { probePaperBroker, validatePaperProbeEnvironment } from "../src/lib/runner/paperProbe";

async function main() {
  const symbol = validatePaperProbeEnvironment(process.env);
  const { KisBrokerClient } = await import("../src/lib/broker/kisBroker");
  const result = await probePaperBroker(new KisBrokerClient(), symbol);
  console.log(JSON.stringify({ event: "paper_probe_succeeded", ...result }));
}

const timeout = setTimeout(() => {
  console.error(JSON.stringify({ event: "paper_probe_timeout", ordersEnabled: false }));
  process.exit(1);
}, 60_000);

main().catch(() => {
  // Broker errors can contain account information; avoid dumping raw responses.
  console.error(JSON.stringify({
    event: "paper_probe_failed",
    message: "Check paper credentials, network access, token issuance limits and broker availability.",
    ordersEnabled: false,
  }));
  process.exitCode = 1;
}).finally(() => clearTimeout(timeout));
