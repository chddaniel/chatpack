import type { PrismaClient } from "../generated/client/client.js";
import { backfillMessageSearchTokens, prismaAdapter } from "../src/index.js";

declare const client: PrismaClient;
prismaAdapter(client);
backfillMessageSearchTokens(client);
