// Endpoint EA FC Web App (UTAS)

export const EA_BASE_URL = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27";

export const TRANSFERMARKET_URL = `${EA_BASE_URL}/transfermarket`;
export const AUCTIONHOUSE_URL = `${EA_BASE_URL}/auctionhouse`;
export const ITEM_URL = `${EA_BASE_URL}/item`;
export const WATCHLIST_URL = `${EA_BASE_URL}/watchlist`;
export const DELETE_SOLD_URL = `${EA_BASE_URL}/trade/sold`;

export const tradeBidUrl = (tradeId) => `${EA_BASE_URL}/trade/${tradeId}/bid`;
