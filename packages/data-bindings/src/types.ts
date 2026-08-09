/**
 * Genormaliseerd Studio4-datamodel — bindings verwijzen hier tegen, niet tegen
 * bronveldnamen (TC, WebU, handmatig). Fase 1 dekt een minimale subset.
 */

export type AccommodationModel = {
  name: string;
  stars?: number;
  description?: string;
  mainImage?: string;
  images?: string[];
  facilities?: string[];
  price?: { amount: number; currency: string; per?: 'night' | 'person' | 'trip' };
  location?: { city?: string; country?: string };
};

export type ActivityModel = {
  title: string;
  description?: string;
  duration?: string;
  image?: string;
};

export type DayModel = {
  index: number;
  date?: string;
  title?: string;
  accommodation?: AccommodationModel;
  activities?: ActivityModel[];
};

export type TripModel = {
  title: string;
  subtitle?: string;
  heroImage?: string;
  days?: DayModel[];
  price?: { amount: number; currency: string };
};

export type Studio4Model = {
  trip?: TripModel;
  accommodation?: AccommodationModel;
  day?: DayModel;
  activity?: ActivityModel;
};
