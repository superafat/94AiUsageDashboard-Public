import type { AppLocation } from '@94ai/client';

export type ProductScreen = AppLocation['route'];

export function screenForRoute(location: AppLocation): ProductScreen {
  return location.route;
}
