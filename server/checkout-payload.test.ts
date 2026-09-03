import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { signCheckoutBody, signCheckoutPayload, verifyCheckoutPayload } from "./checkout-payload";

const REQUEST = {
  receiverAddress: "0x1234567890abcdef1234567890abcdef12345678",
  receiveCoin: "XSGD",
  amount: "100.50",
  chainId: 1,
  orderId: "order-1",
};

describe("checkout payload signing", () => {
  const originalEnv = { secret: process.env.SESSION_SECRET, nodeEnv: process.env.NODE_ENV };

  afterEach(() => {
    process.env.SESSION_SECRET = originalEnv.secret;
    process.env.NODE_ENV = originalEnv.nodeEnv;
  });

  it("round-trips a signed payload", () => {
    const encoded = signCheckoutPayload(REQUEST);
    expect(encoded).toContain(".");
    const verified = verifyCheckoutPayload(encoded);
    expect(verified).not.toBeNull();
    expect(verified?.receiverAddress).toBe(REQUEST.receiverAddress);
    expect(verified?.amount).toBe(REQUEST.amount);
  });

  it("is deterministic for the same body and rejects a re-encoded body", () => {
    const encoded = signCheckoutPayload(REQUEST);
    const [body, signature] = encoded.split(".");
    expect(signCheckoutBody(body)).toBe(signature);

    // Any change to the body — here, a re-priced amount — breaks it.
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    decoded.amount = "0.01";
    const tamperedBody = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    expect(tamperedBody).not.toBe(body);
    expect(verifyCheckoutPayload(`${tamperedBody}.${signature}`)).toBeNull();
  });

  it("rejects a valid-format signature that does not authenticate", () => {
    const encoded = signCheckoutPayload(REQUEST);
    const [body] = encoded.split(".");
    // A different payload signed honestly, spliced onto this body.
    const other = signCheckoutPayload({ ...REQUEST, amount: "1.00" }).split(".")[1];
    expect(verifyCheckoutPayload(`${body}.${other}`)).toBeNull();
  });

  it("rejects unsigned legacy segments", () => {
    const legacy = Buffer.from(JSON.stringify(REQUEST), "utf8").toString("base64url");
    expect(verifyCheckoutPayload(legacy)).toBeNull();
  });

  it("rejects malformed and truncated segments", () => {
    const encoded = signCheckoutPayload(REQUEST);
    expect(verifyCheckoutPayload("")).toBeNull();
    expect(verifyCheckoutPayload(".")).toBeNull();
    expect(verifyCheckoutPayload(`.${encoded.split(".")[1]}`)).toBeNull();
    expect(verifyCheckoutPayload(`${encoded}x`)).toBeNull();
    expect(verifyCheckoutPayload(`${encoded.slice(0, -3)}`)).toBeNull();
  });

  it("does not decode a non-object payload even with a valid signature", () => {
    const arraySegment = signCheckoutPayload([1, 2, 3] as unknown as Record<string, unknown>);
    expect(verifyCheckoutPayload(arraySegment)).toBeNull();
  });

  it("uses the strong SESSION_SECRET when configured", () => {
    process.env.SESSION_SECRET = "x".repeat(48);
    const encoded = signCheckoutPayload(REQUEST);
    expect(verifyCheckoutPayload(encoded)).not.toBeNull();
  });
});
