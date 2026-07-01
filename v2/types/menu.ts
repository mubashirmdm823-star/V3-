// Shapes for v2/data/menu.json and v2/data/restaurant-config.json.

export interface MenuItem {
  id: string;
  name: string;
  price: number;
}

export interface MenuCategory {
  key: string;
  title: string;
  items: MenuItem[];
}

export interface Menu {
  categories: MenuCategory[];
}

export interface RestaurantConfig {
  name: string;
  currency: string;
  address: string;
  mapsUrl: string;
  timing: string;
  phone: string;
  deliveryFee: number;
  deliveryTime: string;
  orderFlow: {
    requiresManualVerification: boolean;
  };
}
