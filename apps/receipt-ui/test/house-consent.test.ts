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
/** What the builder answers each time PayPal gives no answer: true asks again. */
let again: boolean[];

const io = {
  say: (line: string) => said.push(line),
  waitForApproval: async () => {
    approvals += 1;
  },
  askAgain: async () => again.shift() ?? false,
};
const opts = (outPath: string) => ({ outPath, repoRoot: REPO, returnUrl: "https://praman-demo.onrender.com/", requestId: "house-setup-test" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "praman-house-"));
  said = [];
  approvals = 0;
  again = [];
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
  it("treats a file at the repo's root whose name starts with two dots as inside the repo", () => {
    expect(tokenFileProblem(join(REPO, "..house-buyer-token.test-should-never-exist"), REPO)).toContain("inside the repo");
    expect(tokenFileProblem(join(REPO, "..", "house-buyer-token.test-should-never-exist"), REPO)).toBeNull();
  });

  it("says the file couldn't be made, and asks PayPal nothing, when the token file can't be created", async () => {
    const paypal = new FakePayPal();
    let asked = 0;
    const createSetupToken = paypal.createSetupToken.bind(paypal);
    paypal.createSetupToken = async () => {
      asked += 1;
      return createSetupToken();
    };
    // A plain file where the token's folder would have to be.
    writeFileSync(join(dir, "not-a-folder"), "x");
    const result = await consentAsHouseBuyer(paypal, opts(join(dir, "not-a-folder", "house-buyer-token")), io);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("couldn't be created");
    expect(JSON.stringify(result)).toContain("PayPal was not asked");
    expect(asked).toBe(0);
    expect(approvals).toBe(0);
  });

  it("leaves no file and blames nothing on the builder when PayPal gives no answer to the first request", async () => {
    const paypal = new FakePayPal();
    paypal.createSetupToken = async () => {
      throw new Error("ECONNRESET with a secret-looking body");
    };
    const out = join(dir, "house-buyer-token");
    const result = await consentAsHouseBuyer(paypal, opts(out), io);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("gave no answer");
    expect(JSON.stringify(result)).not.toContain("secret-looking");
    expect(existsSync(out)).toBe(false);
    expect(approvals).toBe(0);
  });

  it("asks PayPal again with the same request when the payment token got no answer, and saves the token it then gets", async () => {
    const paypal = new FakePayPal();
    const requests: string[] = [];
    let tries = 0;
    paypal.createPaymentToken = async (setupTokenId: string, requestId?: string) => {
      requests.push(`${setupTokenId}|${requestId ?? ""}`);
      tries += 1;
      if (tries < 3) throw new Error("ETIMEDOUT");
      return { ok: true, value: { id: PAYMENT_TOKEN } };
    };
    again = [true, true];
    const out = join(dir, "house-buyer-token");
    const result = await consentAsHouseBuyer(paypal, opts(out), io);
    expect(result).toEqual({ ok: true, path: out });
    expect(readFileSync(out, "utf8")).toBe(PAYMENT_TOKEN);
    // Each try was the same request, so PayPal can answer the first one's result rather than make another token.
    expect(requests).toHaveLength(3);
    expect(new Set(requests).size).toBe(1);
    expect(approvals).toBe(1);
    expect(said.join("\n")).not.toContain(PAYMENT_TOKEN);
  });

  it("says a token may exist at PayPal when the builder stops after no answer, or PayPal refuses the retry", async () => {
    const lost = new FakePayPal();
    lost.createPaymentToken = async () => {
      throw new Error("ETIMEDOUT");
    };
    again = [false];
    const stopped = await consentAsHouseBuyer(lost, opts(join(dir, "a")), io);
    expect(stopped).toMatchObject({ ok: false });
    expect(JSON.stringify(stopped)).toContain("may have made a payment token");
    expect(JSON.stringify(stopped)).not.toContain("Nothing was saved.");
    expect(existsSync(join(dir, "a"))).toBe(false);

    // The first try is lost, and the second is told the setup token is used up.
    const used = new FakePayPal();
    let tries = 0;
    used.createPaymentToken = async () => {
      tries += 1;
      if (tries === 1) throw new Error("ETIMEDOUT");
      return { ok: false, code: "SETUP_TOKEN_ALREADY_USED" };
    };
    again = [true];
    const refused = await consentAsHouseBuyer(used, opts(join(dir, "b")), io);
    expect(refused).toMatchObject({ ok: false });
    expect(JSON.stringify(refused)).toContain("SETUP_TOKEN_ALREADY_USED");
    expect(JSON.stringify(refused)).toContain("may have made a payment token");
    expect(existsSync(join(dir, "b"))).toBe(false);
  });

  it("tells the builder where PayPal sends the browser, and that an error page there is fine", async () => {
    await consentAsHouseBuyer(new FakePayPal(), opts(join(dir, "house-buyer-token")), io);
    const shown = said.join("\n");
    expect(shown).toContain("https://praman-demo.onrender.com/");
    expect(shown).not.toContain("the demo's front page");
    expect(shown).toContain("error page");
  });

  it("tells the builder, before the approval, to use a sandbox buyer kept for this alone", async () => {
    await consentAsHouseBuyer(new FakePayPal(), opts(join(dir, "house-buyer-token")), io);
    const beforeLink = said.slice(0, said.findIndex((line) => line.includes("approval_session_id=")));
    expect(beforeLink.join("\n")).toContain("not the one whose login you give visitors");
  });
});
