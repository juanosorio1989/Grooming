/** Demo staff. No passwords: `create-owner` sets the owner's; the others cannot log in. */
import type { Skill, StaffRole } from "@prisma/client";

export interface StaffSeed {
  email: string;
  role: StaffRole;
  locale: "en" | "es";
  /** Employee profile (undefined for the owner and reception). */
  profile?: { displayName: string; skills: Skill[]; bio: { en: string; es: string } };
  /** Bathers take a 12:00-12:30 break. */
  breakHours?: boolean;
}

export const STAFF: StaffSeed[] = [
  { email: "owner@demo.dev", role: "OWNER", locale: "en" },
  { email: "reception@demo.dev", role: "RECEPTION", locale: "es" },
  {
    email: "ana.bather@demo.dev", role: "EMPLOYEE", locale: "es", breakHours: true,
    profile: { displayName: "Ana", skills: ["BATHER"], bio: { en: "Bather, loves big dogs.", es: "Bañadora, le encantan los perros grandes." } },
  },
  {
    email: "diego.bather@demo.dev", role: "EMPLOYEE", locale: "es", breakHours: true,
    profile: { displayName: "Diego", skills: ["BATHER"], bio: { en: "Bather and cat whisperer.", es: "Bañador y especialista en gatos." } },
  },
  {
    email: "sam.groomer@demo.dev", role: "EMPLOYEE", locale: "en",
    profile: { displayName: "Sam", skills: ["GROOMER"], bio: { en: "Groomer, scissor work and curly coats.", es: "Peluquero, tijera y pelo rizado." } },
  },
  {
    email: "lia.groomer@demo.dev", role: "EMPLOYEE", locale: "en",
    profile: { displayName: "Lia", skills: ["BATHER", "GROOMER"], bio: { en: "Bather and groomer.", es: "Bañadora y peluquera." } },
  },
];

/** Monday to Saturday. */
export const WORK_WEEKDAYS = [1, 2, 3, 4, 5, 6];
