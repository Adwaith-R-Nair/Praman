import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as approve.ts: dotenv must load before any dynamic import reaches @praman/db.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const { reconcilePending, releaseStaleOrders } = await import("@praman/control-plane");
const { routeByRail } = await import("@praman/exec-core");
const { LiveExecutor } = await import("@praman/razorpay-exec");
const { PayPalExecutor, PAYPAL_SANDBOX_BASE_URL } = await import("@praman/paypal-exec");
const { prisma } = await import("@praman/db");
type Executor = import("@praman/exec-core").Executor;

// Only rails whose keys are in .env. A record on any other rail stays as it is,
// because "I can't ask" is not "it didn't happen". There is no simulator here: it
// would answer "not found" about a real order.
const executors: Executor[] = [];
const rzpId = process.env["RAZORPAY_KEY_ID"];
const rzpSecret = process.env["RAZORPAY_KEY_SECRET"];
if (rzpId && rzpSecret) executors.push(new LiveExecutor(rzpId, rzpSecret));
const ppId = process.env["PAYPAL_CLIENT_ID"];
const ppSecret = process.env["PAYPAL_CLIENT_SECRET"];
if (ppId && ppSecret) executors.push(new PayPalExecutor({ clientId: ppId, clientSecret: ppSecret, baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: globalThis.fetch }));

console.log(`▸ one sweep, asking: ${executors.map((e) => e.rail).join(", ") || "no rail (no keys in .env)"}`);
const route = routeByRail(executors);
const now = new Date();

const resolved = await reconcilePending(route, now);
console.log(`  resolved ${resolved} pending record(s)`);
const released = await releaseStaleOrders(route, now);
console.log(`  released ${released} checkout order(s) not approved within 10 minutes`);

await prisma.$disconnect();
