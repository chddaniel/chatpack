import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const profiles = pgTable("profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  image: text("image"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
