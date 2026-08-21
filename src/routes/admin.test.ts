
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { Email } from "../models/Email.js";
import { EmailTemplate } from "../models/EmailTemplate.js";
import { Project } from "../models/Project.js";
import { generateApiKey } from "../utils/apiKey.js";
import { clearDatabase, connectMemoryMongo, disconnectMemoryMongo } from "../test/mongo.js";

const app = createApp();
const adminHeaders = () => ({ "X-Admin-Token": "test-admin-token" });

let projectId: string;

beforeAll(async () => {
  await connectMemoryMongo();
});
afterAll(async () => {
  await disconnectMemoryMongo();
});

beforeEach(async () => {
  await clearDatabase();
  const key = generateApiKey();
  const project = await Project.create({
    name: "Project X",
    fromAddress: "projectx@minteksoftware.com",
    apiKeyHash: key.hash,
    apiKeyLast4: key.last4,
  });
  projectId = project._id.toString();
  await EmailTemplate.create({
    projectId: project._id,
    name: "welcome",
    subject: "Hi {{name}}",
    format: "markdown",
    body: "Hello **{{name}}**",
  });
  await Email.create({
    projectId: project._id,
    to: "user@example.com",
    from: "projectx@minteksoftware.com",
    subject: "Hi",
    text: "hi",
    status: "sent",
  });
});

describe("GET /admin", () => {
  it("serves the dashboard shell without a token", async () => {
    const res = await request(app).get("/admin");
    expect(res.status).toBe(200);
    expect(res.text).toContain("email-service admin");
  });
});

describe("admin API auth", () => {
  it("rejects requests without a token", async () => {
    const res = await request(app).get("/admin/api/projects");
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const res = await request(app).get("/admin/api/projects").set("X-Admin-Token", "nope");
    expect(res.status).toBe(401);
  });
});

describe("admin API data", () => {
  it("lists projects", async () => {
    const res = await request(app).get("/admin/api/projects").set(adminHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Project X");
    // Never leaks the key hash.
    expect(res.body[0].apiKeyHash).toBeUndefined();
  });

  it("returns a project with its templates and forms", async () => {
    const res = await request(app).get(`/admin/api/projects/${projectId}`).set(adminHeaders());
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe("Project X");
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.forms).toHaveLength(0);
  });

  it("lists a project's emails, filterable by status", async () => {
    const all = await request(app).get(`/admin/api/projects/${projectId}/emails`).set(adminHeaders());
    expect(all.body).toHaveLength(1);

    const filtered = await request(app)
      .get(`/admin/api/projects/${projectId}/emails?status=failed`)
      .set(adminHeaders());
    expect(filtered.body).toHaveLength(0);

    const bad = await request(app)
      .get(`/admin/api/projects/${projectId}/emails?status=bogus`)
      .set(adminHeaders());
    expect(bad.status).toBe(400);
  });

  it("returns full email detail by id", async () => {
    const [email] = await Email.find({});
    const res = await request(app).get(`/admin/api/emails/${email._id}`).set(adminHeaders());
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("hi");
  });

  it("404s an unknown project", async () => {
    const res = await request(app)
      .get("/admin/api/projects/000000000000000000000000")
      .set(adminHeaders());
    expect(res.status).toBe(404);
  });
});

describe("admin project CRUD", () => {
  it("creates a project and returns the API key once", async () => {
    const res = await request(app).post("/admin/api/projects").set(adminHeaders()).send({
      name: "New Co",
      fromAddress: "hi@minteksoftware.com",
      fromName: "New Co",
    });
    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^esk_/);
    expect(res.body.project.apiKeyHash).toBeUndefined();
    expect(await Project.countDocuments({})).toBe(2);
  });

  it("rejects an invalid fromAddress", async () => {
    const res = await request(app).post("/admin/api/projects").set(adminHeaders()).send({
      name: "Bad",
      fromAddress: "not-an-email",
    });
    expect(res.status).toBe(400);
  });

  it("updates a project", async () => {
    const res = await request(app).patch(`/admin/api/projects/${projectId}`).set(adminHeaders()).send({
      fromName: "Renamed",
      active: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.fromName).toBe("Renamed");
    expect(res.body.active).toBe(false);
  });

  it("rotates the API key (old hash changes)", async () => {
    const before = await Project.findById(projectId);
    const res = await request(app)
      .post(`/admin/api/projects/${projectId}/rotate-key`)
      .set(adminHeaders())
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toMatch(/^esk_/);
    const after = await Project.findById(projectId);
    expect(after!.apiKeyHash).not.toBe(before!.apiKeyHash);
  });

  it("cascade-deletes a project with its templates and emails", async () => {
    const res = await request(app).delete(`/admin/api/projects/${projectId}`).set(adminHeaders());
    expect(res.status).toBe(204);
    expect(await Project.countDocuments({})).toBe(0);
    expect(await EmailTemplate.countDocuments({})).toBe(0);
    expect(await Email.countDocuments({})).toBe(0);
  });
});

describe("admin template CRUD", () => {
  it("creates a template", async () => {
    const res = await request(app)
      .post(`/admin/api/projects/${projectId}/templates`)
      .set(adminHeaders())
      .send({ name: "promo", subject: "Hi", format: "markdown", body: "**hi**" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("promo");
  });

  it("rejects a duplicate template name", async () => {
    const res = await request(app)
      .post(`/admin/api/projects/${projectId}/templates`)
      .set(adminHeaders())
      .send({ name: "welcome", subject: "Hi", format: "markdown", body: "x" });
    expect(res.status).toBe(409);
  });

  it("updates and deletes a template", async () => {
    const [t] = await EmailTemplate.find({});
    const upd = await request(app)
      .patch(`/admin/api/templates/${t._id}`)
      .set(adminHeaders())
      .send({ subject: "Changed" });
    expect(upd.status).toBe(200);
    expect(upd.body.subject).toBe("Changed");

    const del = await request(app).delete(`/admin/api/templates/${t._id}`).set(adminHeaders());
    expect(del.status).toBe(204);
    expect(await EmailTemplate.countDocuments({})).toBe(0);
  });

  it("guards mutations behind the admin token", async () => {
    const res = await request(app)
      .post(`/admin/api/projects/${projectId}/templates`)
      .send({ name: "x", subject: "y", format: "markdown", body: "z" });
    expect(res.status).toBe(401);
  });
});
