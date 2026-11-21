import { Injectable } from "@nestjs/common";
import type {
  Breed,
  BreedQuery,
  LocalizedText,
  PublicEmployee,
  PublicLocation,
  PublicServices,
} from "@grooming/contracts";
import { dbTimeToWall } from "../common/wall-time.js";
import { LocationService } from "../location/location.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import breedsData from "./breeds.json";

const BREEDS: Breed[] = (breedsData as Breed[]).slice().sort((a, b) => a.en.localeCompare(b.en));

const SIZE_ORDER = ["S", "M", "L", "XL"];
const COAT_ORDER = ["SMOOTH", "DOUBLE", "CURLY", "WIRE", "LONG", "HAIRLESS"];

/** Unauthenticated reads for the owner booking web. Exposes only the fields the contracts list. */
@Injectable()
export class PublicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly location: LocationService,
  ) {}

  async locations(): Promise<PublicLocation[]> {
    const organizationId = await this.tenancy.getOrgId();
    const def = await this.location.getDefault();
    const loc = await this.prisma.location.findFirst({
      where: { id: def.id, organizationId },
      select: {
        id: true,
        name: true,
        address: true,
        phone: true,
        timezone: true,
        hours: { orderBy: [{ weekday: "asc" }, { opens: "asc" }] },
      },
    });
    if (!loc) return [];
    return [
      {
        id: loc.id,
        name: loc.name,
        address: loc.address,
        phone: loc.phone,
        timezone: loc.timezone,
        defaultBookingMode: def.settings.defaultBookingMode,
        hours: loc.hours.map((h) => ({ weekday: h.weekday, opens: dbTimeToWall(h.opens, false), closes: dbTimeToWall(h.closes, true) })),
      },
    ];
  }

  async services(): Promise<PublicServices> {
    const organizationId = await this.tenancy.getOrgId();
    const [cats, rows] = await Promise.all([
      this.prisma.serviceCategory.findMany({ where: { organizationId }, orderBy: [{ sort: "asc" }, { id: "asc" }] }),
      this.prisma.service.findMany({ where: { organizationId, active: true, onlineBookable: true }, include: { prices: true } }),
    ]);
    const sortOf = new Map(cats.map((c) => [c.id, c.sort]));
    const rank = (categoryId: string | null) => (categoryId ? (sortOf.get(categoryId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER);
    const en = (s: { name: unknown }) => (s.name as LocalizedText).en;
    const services = rows
      .sort((a, b) => rank(a.categoryId) - rank(b.categoryId) || Number(b.isMain) - Number(a.isMain) || en(a).localeCompare(en(b)) || a.id.localeCompare(b.id))
      .map((s) => ({
        id: s.id,
        categoryId: s.categoryId,
        name: s.name as unknown as LocalizedText,
        description: (s.description as unknown as LocalizedText | null) ?? null,
        species: s.species,
        stage: s.stage,
        isMain: s.isMain,
        bookingMode: s.bookingMode,
        prices: s.prices
          .map((p) => ({ sizeClass: p.sizeClass, coatType: p.coatType, durationMin: p.durationMin, priceCents: p.priceCents }))
          .sort(
            (a, b) =>
              SIZE_ORDER.indexOf(a.sizeClass) - SIZE_ORDER.indexOf(b.sizeClass) ||
              (a.coatType === null ? -1 : COAT_ORDER.indexOf(a.coatType)) - (b.coatType === null ? -1 : COAT_ORDER.indexOf(b.coatType)),
          ),
      }));
    return { categories: cats.map((c) => ({ id: c.id, name: c.name as unknown as LocalizedText, sort: c.sort })), services };
  }

  async employees(): Promise<PublicEmployee[]> {
    const organizationId = await this.tenancy.getOrgId();
    const rows = await this.prisma.staffUser.findMany({
      where: { organizationId, active: true, employeeProfile: { is: { bookableOnline: true, skills: { isEmpty: false } } } },
      include: { employeeProfile: true, employeeServices: { where: { service: { active: true, onlineBookable: true } }, select: { serviceId: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    return rows.flatMap((s) => {
      const p = s.employeeProfile;
      if (!p) return [];
      return [
        {
          id: s.id,
          displayName: p.displayName,
          bio: (p.bio as LocalizedText | null) ?? null,
          photoUrl: p.photoUrl,
          skills: p.skills,
          serviceIds: s.employeeServices.map((e) => e.serviceId).sort(),
        },
      ];
    });
  }

  breeds(q: BreedQuery): Breed[] {
    return q.species ? BREEDS.filter((b) => b.species === q.species) : BREEDS;
  }
}
