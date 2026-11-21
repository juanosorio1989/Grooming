/** Demo owners, pets and three completed past visits. */
import type { CoatType, Species, Temperament, VaccineType } from "@prisma/client";

export interface PetSeed {
  name: string;
  species: Species;
  breed: string;
  weightLb: number;
  coatType: CoatType;
  sex: "MALE" | "FEMALE";
  temperament?: Temperament[];
  allergies?: string[];
  behaviorNotes?: string;
  /** Vaccine expiry as days from today (negative = expired). */
  vaccines: { type: VaccineType; expiresInDays: number }[];
}

export interface CustomerSeed {
  phoneE164: string;
  name: string;
  email: string;
  locale: "en" | "es";
  pets: PetSeed[];
}

export const CUSTOMERS: CustomerSeed[] = [
  {
    phoneE164: "+12125550101", name: "Maria Gonzalez", email: "maria@example.com", locale: "es",
    pets: [
      { name: "Luna", species: "DOG", breed: "Chihuahua", weightLb: 8, coatType: "SMOOTH", sex: "FEMALE", vaccines: [{ type: "RABIES", expiresInDays: 200 }] },
      {
        name: "Rocky", species: "DOG", breed: "Labrador Retriever", weightLb: 70, coatType: "SMOOTH", sex: "MALE",
        temperament: ["NEEDS_MUZZLE"], allergies: ["chicken", "oatmeal shampoo"], behaviorNotes: "Snaps when his back paws are handled.",
        vaccines: [{ type: "RABIES", expiresInDays: 120 }, { type: "DHPP", expiresInDays: 120 }],
      },
    ],
  },
  {
    phoneE164: "+12125550102", name: "James Carter", email: "james@example.com", locale: "en",
    pets: [{ name: "Max", species: "DOG", breed: "Golden Retriever", weightLb: 68, coatType: "DOUBLE", sex: "MALE", vaccines: [{ type: "RABIES", expiresInDays: 300 }] }],
  },
  {
    phoneE164: "+12125550103", name: "Sofia Ramirez", email: "sofia@example.com", locale: "es",
    pets: [{ name: "Coco", species: "DOG", breed: "Standard Poodle", weightLb: 45, coatType: "CURLY", sex: "FEMALE", temperament: ["NERVOUS"], vaccines: [{ type: "RABIES", expiresInDays: -30 }] }],
  },
  {
    phoneE164: "+12125550104", name: "Emily Chen", email: "emily@example.com", locale: "en",
    pets: [
      { name: "Bear", species: "DOG", breed: "Newfoundland", weightLb: 110, coatType: "DOUBLE", sex: "MALE", vaccines: [{ type: "RABIES", expiresInDays: 250 }] },
      { name: "Mochi", species: "CAT", breed: "Domestic Shorthair", weightLb: 10, coatType: "SMOOTH", sex: "FEMALE", vaccines: [{ type: "RABIES", expiresInDays: 180 }] },
    ],
  },
];

export interface VisitStepSeed {
  /** Service name (English) and species picks the service. */
  service: string;
  staffEmail: string;
  resource: string | null;
}

export interface VisitSeed {
  /** Natural key stored in `appointment.notes`. */
  key: string;
  customerPhone: string;
  pet: string;
  daysAgo: number;
  /** Drop-off hour, UTC. */
  startHourUtc: number;
  services: VisitStepSeed[];
  kennel: string | null;
  observation?: { kind: "MATTING" | "SKIN_IRRITATION"; severity: "LOW" | "MEDIUM" | "HIGH"; note: string; staffEmail: string };
  report: { summaryNote: string; recommendations: string; nextVisitWeeks: number };
}

export const VISITS: VisitSeed[] = [
  {
    key: "seed:visit:1", customerPhone: "+12125550102", pet: "Max", daysAgo: 25, startHourUtc: 14,
    services: [
      { service: "Bath & brush", staffEmail: "ana.bather@demo.dev", resource: "Tub 1" },
      { service: "Blow dry", staffEmail: "ana.bather@demo.dev", resource: "Dryer 1" },
      { service: "Nail trim", staffEmail: "lia.groomer@demo.dev", resource: null },
    ],
    kennel: null,
    report: { summaryNote: "Max was a happy boy. Undercoat brushed out well.", recommendations: "Brush twice a week to keep shedding down.", nextVisitWeeks: 6 },
  },
  {
    key: "seed:visit:2", customerPhone: "+12125550103", pet: "Coco", daysAgo: 12, startHourUtc: 14,
    services: [
      { service: "Full groom", staffEmail: "sam.groomer@demo.dev", resource: "Table 1" },
      { service: "Ear cleaning", staffEmail: "sam.groomer@demo.dev", resource: null },
    ],
    kennel: "Kennel 1",
    observation: { kind: "MATTING", severity: "MEDIUM", note: "Mats behind the ears and in the armpits; trimmed short.", staffEmail: "sam.groomer@demo.dev" },
    report: { summaryNote: "Coco was a little nervous but did great.", recommendations: "Daily brushing behind the ears to avoid mats.", nextVisitWeeks: 5 },
  },
  {
    key: "seed:visit:3", customerPhone: "+12125550104", pet: "Mochi", daysAgo: 4, startHourUtc: 15,
    services: [
      { service: "Cat bath", staffEmail: "diego.bather@demo.dev", resource: "Tub 2" },
      { service: "Nail trim", staffEmail: "lia.groomer@demo.dev", resource: null },
    ],
    kennel: "Kennel 2",
    report: { summaryNote: "Mochi tolerated the bath calmly. Coat is soft and clean.", recommendations: "A bath every 8 weeks is plenty.", nextVisitWeeks: 8 },
  },
];
