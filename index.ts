import { app } from "./src/main";
import { connectNats } from "./src/services/nats.publisher";

// Start the server. All app + swagger setup lives in src/main.ts
app.listen(process.env.PORT ?? 3001);

// Best-effort NATS connection (logs success/failure — never blocks boot).
connectNats();

const { hostname, port } = app.server!;
console.log(`🦊 Connection Service running at http://${hostname}:${port}`);
console.log(`📚 Swagger UI: http://${hostname}:${port}/swagger`);
console.log(`📄 OpenAPI JSON: http://${hostname}:${port}/swagger/json`);
