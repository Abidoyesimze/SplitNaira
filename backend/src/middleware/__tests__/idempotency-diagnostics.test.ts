/**
 * Idempotency conflict diagnostics (Issue #1248).
 *
 * `idempotency-conflict.test.ts` pins the 409 error envelope. These tests pin
 * the machine-readable `Idempotency-Status` / `Idempotency-Conflict-Reason`
 * headers that let a client tell a *duplicate success* (replayed 2xx) apart
 * from a *conflict* (different payload or an in-flight first attempt) without
 * parsing the body — and confirm the raw stored request is never echoed back.
 */
import express, { type Request, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { idempotencyMiddleware } from "../idempotency.js";
import { requestIdMiddleware } from "../request-id.js";
import { errorHandler, notFoundHandler } from "../error.js";
import { IdempotencyStore } from "../../services/idempotency.js";

const KEY = "diagnostics-key";

let store: IdempotencyStore;
let handler: Mock<(req: Request, res: Response) => unknown>;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);

  app.post("/payments", idempotencyMiddleware(store), (req, res) => handler(req, res));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function send(app: express.Express, body: unknown, key = KEY) {
  return request(app)
    .post("/payments")
    .set("Idempotency-Key", key)
    .send(body as object);
}

beforeEach(() => {
  store = new IdempotencyStore();
  handler = vi.fn((req: Request, res: Response) => {
    res.status(201).json({ id: "payment-1", amount: req.body.amount });
  });
});

describe("idempotency outcome diagnostics (Issue #1248)", () => {
  it("marks a first stored request", async () => {
    const res = await send(createApp(), { amount: 100 }).expect(201);

    expect(res.headers["idempotency-status"]).toBe("stored");
    expect(res.headers["idempotency-conflict-reason"]).toBeUndefined();
  });

  it("distinguishes a duplicate success from a conflict", async () => {
    const app = createApp();
    await send(app, { amount: 100 }).expect(201);

    const replay = await send(app, { amount: 100 }).expect(201);
    expect(replay.headers["idempotency-status"]).toBe("replayed");
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.headers["idempotency-conflict-reason"]).toBeUndefined();

    const conflict = await send(app, { amount: 200 }).expect(409);
    expect(conflict.headers["idempotency-status"]).toBe("conflict");
    expect(conflict.headers["idempotency-conflict-reason"]).toBe("payload_mismatch");
    expect(conflict.headers["idempotency-replayed"]).toBeUndefined();
  });

  it("reports an in-flight first attempt separately", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    handler = vi.fn(async (req: Request, res: Response) => {
      await gate;
      res.status(201).json({ id: "payment-1", amount: req.body.amount });
    });
    const app = createApp();

    const first = send(app, { amount: 100 }).then((r) => r);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));

    const inflight = await send(app, { amount: 100 }).expect(409);
    expect(inflight.headers["idempotency-status"]).toBe("in_progress");
    expect(inflight.headers["idempotency-conflict-reason"]).toBe("in_flight");
    expect(inflight.body.code).toBe("IDEMPOTENCY_KEY_IN_PROGRESS");

    release();
    expect((await first).status).toBe(201);
  });

  it("does not echo the stored request body on conflict", async () => {
    const app = createApp();
    await send(app, { amount: 100, secret: "super-secret" }).expect(201);

    const conflict = await send(app, { amount: 200, secret: "other-secret" }).expect(409);

    const serialized = JSON.stringify(conflict.body);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("other-secret");
  });

  it("keeps the stable conflict codes", async () => {
    const app = createApp();
    await send(app, { amount: 100 }).expect(201);

    const conflict = await send(app, { amount: 200 }).expect(409);
    expect(conflict.body).toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      error: "idempotency_key_conflict",
    });
  });
});
