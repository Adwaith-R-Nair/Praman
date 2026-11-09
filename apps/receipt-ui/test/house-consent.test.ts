import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consentAsHouseBuyer, tokenFileProblem } from "../src/demo/house-consent.js";
import { FakePayPal, PAYMENT_TOKEN, SETUP_TOKEN } from "./stand-ins.js";

// The builder's one-time consent as the demo's sandbox buyer (D-85), with the stand-in
// PayPal. The token it saves is a secret: it goes to one file outside the repo and is
// never said.

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
let dir: string;
let said: string[];
let approvals: number;

const io = {
  say: (line: string) => said.push(line),
  waitForApproval: async () => {
    approvals += 1;
  },
};
const opts = (outPath: string) => ({ outPath, repoRoot: REPO, returnUrl: "https://praman-demo.onrender.com/", requestId: "house-setup-test" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "praman-house-"));
  said = [];
  approvals = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("consenting once as the demo's sandbox buyer", () => {
  it("saves the payment token to a private file outside the repo and never says it", async () => {
    const out = join(dir, "nested", "house-buyer-token");
    const result = await consentAsHouseBuyer(new FakePayPal(), opts(out), io);
    expect(result).toEqual({ ok: true, path: out });
    expect(readFileSync(out, "utf8")).toBe(PAYMENT_TOKEN);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(approvals).toBe(1);
    const shown = said.join("\n");
    expect(shown).toContain(`approval_session_id=${SETUP_TOKEN}`);
    expect(shown).toContain(out);
    expect(shown).not.toContain(PAYMENT_TOKEN);
    expect(JSON.stringify(result)).not.toContain(PAYMENT_TOKEN);
  });

  it("refuses a file inside the repo, directly or through a link, before asking PayPal anything", async () => {
    const paypal = new FakePayPal();
    let asked = 0;
    paypal.createSetupToken = async () => {
      asked += 1;
      return { ok: false, code: "UNUSED" };
    };
    const inside = join(REPO, "house-buyer-token.test-should-never-exist");
    expect(tokenFileProblem(inside, REPO)).toContain("inside the repo");
    expect(await consentAsHouseBuyer(paypal, opts(inside), io)).toMatchObject({ ok: false });
    expect(existsSync(inside)).toBe(false);

    const link = join(dir, "link");
    symlinkSync(join(REPO, "docs"), link);
    expect(tokenFileProblem(join(link, "house-buyer-token"), REPO)).toContain("inside the repo");
    expect(tokenFileProblem(join(dir, "house-buyer-token"), REPO)).toBeNull();
    expect(asked).toBe(0);
    expect(approvals).toBe(0);
  });

  it("never overwrites a file that is already there", async () => {
    const out = join(dir, "house-buyer-token");
    writeFileSync(out, "an earlier token");
    const result = await consentAsHouseBuyer(new FakePayPal(), opts(out), io);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("already exists");
    expect(readFileSync(out, "utf8")).toBe("an earlier token");
    expect(approvals).toBe(0);
  });

  it("saves nothing and leaves no file when PayPal refuses the setup or doesn't confirm the approval", async () => {
    const noSetup = new FakePayPal();
    noSetup.createSetupToken = async () => ({ ok: false, code: "NOT_AUTHORIZED" });
    const first = await consentAsHouseBuyer(noSetup, opts(join(dir, "a")), io);
    expect(first).toMatchObject({ ok: false });
    expect(JSON.stringify(first)).toContain("NOT_AUTHORIZED");
    expect(existsSync(join(dir, "a"))).toBe(false);
    expect(approvals).toBe(0);

    const notApproved = new FakePayPal();
    notApproved.createPaymentToken = async () => ({ ok: false, code: "SETUP_TOKEN_NOT_APPROVED" });
    const second = await consentAsHouseBuyer(notApproved, opts(join(dir, "b")), io);
    expect(second).toMatchObject({ ok: false });
    expect(JSON.stringify(second)).toContain("SETUP_TOKEN_NOT_APPROVED");
    expect(existsSync(join(dir, "b"))).toBe(false);

    const lost = new FakePayPal();
    lost.createPaymentToken = async () => {
      throw new Error("ETIMEDOUT with a secret-looking body");
    };
    const third = await consentAsHouseBuyer(lost, opts(join(dir, "c")), io);
    expect(third).toMatchObject({ ok: false });
    expect(JSON.stringify(third)).not.toContain("secret-looking");
    expect(existsSync(join(dir, "c"))).toBe(false);
  });
});
