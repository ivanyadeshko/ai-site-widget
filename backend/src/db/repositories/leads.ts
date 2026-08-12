import type { Queryable } from '../pool.ts';

export type InsertLeadInput = {
  dialogId: string;
  widgetId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  comment: string | null;
  consent: boolean;
};

export type LeadRow = { id: string; created_at: Date };

export async function insertLead(db: Queryable, input: InsertLeadInput): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO leads (dialog_id, widget_id, name, phone, email, comment, consent)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.dialogId, input.widgetId, input.name, input.phone, input.email, input.comment, input.consent],
  );
  return rows[0]!.id;
}
