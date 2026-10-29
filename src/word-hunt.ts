import { getContextCategory } from "./embeddings.ts";

export type HuntMode = "rounds" | "marathon";
export const huntThemes = [
  { id: "mystery", label: "Mystery", categories: [] },
  { id: "animals", label: "Animals & wildlife", categories: ["Animals & wildlife"] },
  { id: "food", label: "Food & drink", categories: ["Food & drink"] },
  { id: "nature", label: "Nature & gardens", categories: ["Nature & weather", "Plants & gardens", "Nature & outdoors", "The natural world"] },
  { id: "home", label: "Home & furniture", categories: ["Home & furniture", "Everyday objects"] },
  { id: "travel", label: "Transport & travel", categories: ["Transport & travel"] },
  { id: "sports", label: "Sports & games", categories: ["Sports & games"] },
  { id: "technology", label: "Tools & technology", categories: ["Tools & technology", "Making & fixing things"] },
];
export function themeWords(words: string[], theme: string): string[] {
  const definition = huntThemes.find((entry) => entry.id === theme) || huntThemes[0]!;
  return definition.id === "mystery" ? words : words.filter((word) => definition.categories.includes(getContextCategory(word) || ""));
}
export const themeLabel = (id: string) => huntThemes.find((entry) => entry.id === id)?.label || "Mystery";
export type ThemeVote = { endsAt: number; options: Array<{ id: string; label: string; votes: number }>; ballots: Record<string, number> };
export type HuntNotice = { id: string; text: string; at: number; claimed: boolean };
export const VOTE_MS = 10_000;
export const MARATHON_BONUS_MS = 15_000;
