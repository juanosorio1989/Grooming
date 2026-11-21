/** Demo catalog: categories and services with EN/ES names and the S/M/L/XL price matrix. */
import type { ServiceSpecies, Skill, Stage } from "@prisma/client";

export const CATEGORIES = [
  { en: "Baths", es: "Baños", sort: 1 },
  { en: "Grooming", es: "Peluquería", sort: 2 },
  { en: "Add-ons", es: "Extras", sort: 3 },
] as const;

export type CategoryEn = (typeof CATEGORIES)[number]["en"];
/** Resource type names (English) created by the seed; `null` = no station (FINISH). */
export type ResourceEn = "Tub" | "Table" | "Dryer" | null;

export interface ServiceSeed {
  en: string;
  es: string;
  species: ServiceSpecies;
  stage: Stage;
  isMain: boolean;
  category: CategoryEn;
  resource: ResourceEn;
  skill: Skill;
  bufferAfterMin: number;
  /** Whole dollars for S, M, L, XL. */
  dollars: [number, number, number, number];
  /** Minutes (multiples of 5) for S, M, L, XL. */
  minutes: [number, number, number, number];
  /** Main DOG services also get DOUBLE and CURLY rows (+15 % price, +15 min). */
  coatSurcharge?: boolean;
}

const flat = (n: number): [number, number, number, number] => [n, n, n, n];

export const SERVICES: ServiceSeed[] = [
  { en: "Bath & brush", es: "Baño y cepillado", species: "DOG", stage: "BATH", isMain: true, category: "Baths", resource: "Tub", skill: "BATHER", bufferAfterMin: 5, dollars: [45, 55, 70, 90], minutes: [45, 60, 75, 90], coatSurcharge: true },
  { en: "Full groom", es: "Peluquería completa", species: "DOG", stage: "GROOM", isMain: true, category: "Grooming", resource: "Table", skill: "GROOMER", bufferAfterMin: 5, dollars: [65, 80, 100, 130], minutes: [90, 105, 120, 150], coatSurcharge: true },
  { en: "Puppy groom", es: "Peluquería de cachorro", species: "DOG", stage: "GROOM", isMain: true, category: "Grooming", resource: "Table", skill: "GROOMER", bufferAfterMin: 5, dollars: [45, 55, 70, 85], minutes: [60, 70, 80, 90], coatSurcharge: true },
  { en: "De-shedding treatment", es: "Tratamiento de muda", species: "DOG", stage: "BATH", isMain: true, category: "Baths", resource: "Tub", skill: "BATHER", bufferAfterMin: 5, dollars: [55, 70, 90, 115], minutes: [60, 75, 90, 105], coatSurcharge: true },
  { en: "Nail trim", es: "Corte de uñas", species: "DOG", stage: "FINISH", isMain: false, category: "Add-ons", resource: null, skill: "GROOMER", bufferAfterMin: 0, dollars: flat(15), minutes: [10, 10, 15, 15] },
  { en: "Teeth brushing", es: "Cepillado de dientes", species: "DOG", stage: "FINISH", isMain: false, category: "Add-ons", resource: null, skill: "GROOMER", bufferAfterMin: 0, dollars: flat(12), minutes: flat(10) },
  { en: "Ear cleaning", es: "Limpieza de oídos", species: "DOG", stage: "FINISH", isMain: false, category: "Add-ons", resource: null, skill: "GROOMER", bufferAfterMin: 0, dollars: flat(12), minutes: flat(10) },
  { en: "Paw balm", es: "Bálsamo para patas", species: "DOG", stage: "FINISH", isMain: false, category: "Add-ons", resource: null, skill: "GROOMER", bufferAfterMin: 0, dollars: flat(10), minutes: flat(5) },
  { en: "Flea shampoo", es: "Champú antipulgas", species: "DOG", stage: "BATH", isMain: false, category: "Add-ons", resource: "Tub", skill: "BATHER", bufferAfterMin: 0, dollars: [20, 25, 30, 35], minutes: [15, 15, 20, 20] },
  { en: "Blueberry facial", es: "Facial de arándanos", species: "DOG", stage: "BATH", isMain: false, category: "Add-ons", resource: "Tub", skill: "BATHER", bufferAfterMin: 0, dollars: flat(10), minutes: flat(10) },
  { en: "Blow dry", es: "Secado", species: "DOG", stage: "DRY", isMain: false, category: "Add-ons", resource: "Dryer", skill: "BATHER", bufferAfterMin: 5, dollars: [15, 20, 25, 30], minutes: [15, 20, 25, 30] },
  { en: "Bandana & cologne", es: "Pañuelo y colonia", species: "DOG", stage: "FINISH", isMain: false, category: "Add-ons", resource: null, skill: "GROOMER", bufferAfterMin: 0, dollars: flat(8), minutes: flat(5) },
  { en: "Cat bath", es: "Baño de gato", species: "CAT", stage: "BATH", isMain: true, category: "Baths", resource: "Tub", skill: "BATHER", bufferAfterMin: 5, dollars: [50, 55, 60, 65], minutes: [45, 50, 55, 60] },
  { en: "Lion cut", es: "Corte de león", species: "CAT", stage: "GROOM", isMain: true, category: "Grooming", resource: "Table", skill: "GROOMER", bufferAfterMin: 5, dollars: [80, 90, 100, 110], minutes: [75, 90, 100, 110] },
  { en: "Nail trim", es: "Corte de uñas", species: "CAT", stage: "FINISH", isMain: false, category: "Add-ons", resource: null, skill: "GROOMER", bufferAfterMin: 0, dollars: flat(15), minutes: flat(10) },
];

export const SIZES = ["S", "M", "L", "XL"] as const;
