export async function healthRoutes(app, { store }) {
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    if (!store) return reply.code(503).send({ status: "not_ready", database: false, schema: false });
    const readiness = await store.readiness();
    const ready = readiness.database && readiness.schema;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      database: readiness.database,
      schema: readiness.schema,
    });
  });
}
