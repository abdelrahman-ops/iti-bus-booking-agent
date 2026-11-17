import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "../src/auth/session.js";
import { ItiClient, NetworkTimeoutError } from "../src/api/iti-client.js";

function createMockJwt(expSecondsFromNow = 3600): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + expSecondsFromNow;
  const payload = Buffer.from(JSON.stringify({ sub: "user123", exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("Auth Session & ItiClient Mocked API", () => {
  it("refreshes access token via POST /api/v1/auth/refresh and stores it in memory", async () => {
    let postCalls = 0;
    const testJwt = createMockJwt(1800);

    const mockContext = {
      request: {
        post: async (url: string) => {
          postCalls++;
          assert.match(url, /\/api\/v1\/auth\/refresh$/);
          return {
            ok: () => true,
            status: () => 200,
            json: async () => ({
              success: true,
              data: { accessToken: testJwt, tokenType: "Bearer" }
            })
          };
        }
      }
    } as any;

    const session = new SessionManager(mockContext);
    const token1 = await session.getAccessToken();
    assert.equal(token1, testJwt);
    assert.equal(postCalls, 1);

    // Second call before expiry should reuse in-memory token without calling refresh endpoint again
    const token2 = await session.getAccessToken();
    assert.equal(token2, testJwt);
    assert.equal(postCalls, 1);
  });

  it("handles HTTP 401 by refreshing session and retrying request once", async () => {
    let refreshCalls = 0;
    let getCalls = 0;
    const testJwt = createMockJwt(3600);

    const mockContext = {
      request: {
        post: async (url: string) => {
          if (url.includes("/api/v1/auth/refresh")) {
            refreshCalls++;
            return {
              ok: () => true,
              status: () => 200,
              json: async () => ({
                success: true,
                data: { accessToken: testJwt }
              })
            };
          }
          throw new Error(`Unexpected post url: ${url}`);
        },
        get: async (url: string) => {
          getCalls++;
          if (getCalls === 1) {
            // First call returns 401 Unauthorized
            return {
              ok: () => false,
              status: () => 401,
              headers: () => ({}),
              json: async () => ({ message: "Unauthorized" })
            };
          }
          // Retry returns 200 OK
          return {
            ok: () => true,
            status: () => 200,
            headers: () => ({}),
            json: async () => ({
              success: true,
              data: [{ id: 400, routeName: "خط 6 أكتوبر" }]
            })
          };
        }
      }
    } as any;

    const session = new SessionManager(mockContext);
    const client = new ItiClient(mockContext, session);

    const trips = await client.getAvailableTrips("2026-11-20");
    assert.equal(trips.length, 1);
    assert.equal(getCalls, 2, "Availability endpoint should be retried once after 401");
    assert.equal(refreshCalls, 2, "Refresh should be called once initially and once on 401");
  });

  it("handles HTTP 429 by observing Retry-After header and retrying once", async () => {
    let getCalls = 0;
    const testJwt = createMockJwt(3600);

    const mockContext = {
      request: {
        post: async () => ({
          ok: () => true,
          status: () => 200,
          json: async () => ({ success: true, data: { accessToken: testJwt } })
        }),
        get: async () => {
          getCalls++;
          if (getCalls === 1) {
            return {
              ok: () => false,
              status: () => 429,
              headers: () => ({ "retry-after": "0.1" }), // 100ms
              json: async () => ({ message: "Too many requests" })
            };
          }
          return {
            ok: () => true,
            status: () => 200,
            headers: () => ({}),
            json: async () => ({
              success: true,
              data: []
            })
          };
        }
      }
    } as any;

    const session = new SessionManager(mockContext);
    const client = new ItiClient(mockContext, session);

    const trips = await client.getAvailableTrips("2026-11-20");
    assert.equal(trips.length, 0);
    assert.equal(getCalls, 2, "Should retry once after backing off from 429");
  });

  it("wraps fetch failures in NetworkTimeoutError", async () => {
    const testJwt = createMockJwt(3600);

    const mockContext = {
      request: {
        post: async () => ({
          ok: () => true,
          status: () => 200,
          json: async () => ({ success: true, data: { accessToken: testJwt } })
        }),
        get: async () => {
          throw new Error("connect ETIMEDOUT 192.0.2.1:443");
        }
      }
    } as any;

    const session = new SessionManager(mockContext);
    const client = new ItiClient(mockContext, session);

    await assert.rejects(
      async () => {
        await client.getAvailableTrips("2026-11-20");
      },
      (err: unknown) => {
        assert.ok(err instanceof NetworkTimeoutError);
        assert.match((err as Error).message, /ETIMEDOUT/);
        return true;
      }
    );
  });
});
