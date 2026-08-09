import type { Studio4Model } from './types.js';

export const luxuryResort: Studio4Model = {
  accommodation: {
    name: 'Villa Aurora',
    stars: 5,
    description: 'Boutique-resort met privéstrand aan de Amalfikust.',
    mainImage: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=1600',
    images: ['https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=1600'],
    facilities: ['Zwembad', 'Spa', 'Privéstrand', 'Restaurant', 'Wifi'],
    price: { amount: 780, currency: 'EUR', per: 'night' },
    location: { city: 'Positano', country: 'Italië' },
  },
};

export const budgetBnB: Studio4Model = {
  accommodation: {
    name: 'Casa da Vila',
    stars: 2,
    description: 'Gastvrije familie-B&B in het historische centrum.',
    mainImage: 'https://images.unsplash.com/photo-1512918728675-ed5a9ecdebfd?w=1600',
    facilities: ['Wifi', 'Ontbijt'],
    price: { amount: 65, currency: 'EUR', per: 'night' },
    location: { city: 'Porto', country: 'Portugal' },
  },
};

export const missingImage: Studio4Model = {
  accommodation: {
    name: 'Onbekend adres',
    stars: 3,
    description: 'Aankomstadres nog te bevestigen.',
    facilities: ['Wifi'],
    location: { city: '—', country: '—' },
  },
};

export const SAMPLE_DATA_VARIANTS = {
  luxury: luxuryResort,
  budget: budgetBnB,
  'missing-image': missingImage,
} as const;

export type SampleDataVariant = keyof typeof SAMPLE_DATA_VARIANTS;
