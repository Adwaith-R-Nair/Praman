import { prisma } from "@praman/db";

const MERCHANT_ID = process.argv[2] ?? "MERCH_001";

interface Item {
  sku: string;
  title: string;
  description: string;
  category: "food" | "beverage";
  pricePaise: bigint;
  stockQty: number;
}

const ITEMS: Item[] = [
  { sku: "SKU_FOOD_001", title: "Veg Thali", description: "Rice, dal, two seasonal sabzis, roti, salad, pickle", category: "food", pricePaise: 18000n, stockQty: 40 },
  { sku: "SKU_FOOD_002", title: "Paneer Butter Masala + Rice", description: "Creamy tomato-paneer curry with steamed basmati", category: "food", pricePaise: 22000n, stockQty: 30 },
  { sku: "SKU_FOOD_003", title: "Chicken Biryani", description: "Hyderabadi-style dum biryani, raita included", category: "food", pricePaise: 26000n, stockQty: 25 },
  { sku: "SKU_FOOD_004", title: "Veg Biryani", description: "Mixed vegetable dum biryani, raita included", category: "food", pricePaise: 19000n, stockQty: 30 },
  { sku: "SKU_FOOD_005", title: "Masala Dosa", description: "Crisp rice crepe, potato filling, sambar, chutney", category: "food", pricePaise: 12000n, stockQty: 50 },
  { sku: "SKU_FOOD_006", title: "Idli Sambar (4 pc)", description: "Steamed rice cakes, sambar, coconut chutney", category: "food", pricePaise: 9000n, stockQty: 50 },
  { sku: "SKU_FOOD_007", title: "Chole Bhature", description: "Spiced chickpea curry with fried bread", category: "food", pricePaise: 14000n, stockQty: 35 },
  { sku: "SKU_FOOD_008", title: "Rajma Chawal", description: "Kidney bean curry with steamed rice", category: "food", pricePaise: 13000n, stockQty: 35 },
  { sku: "SKU_FOOD_009", title: "Butter Chicken + Naan", description: "Classic butter chicken, one garlic naan", category: "food", pricePaise: 27000n, stockQty: 25 },
  { sku: "SKU_FOOD_010", title: "Dal Makhani + Rice", description: "Slow-cooked black lentils, steamed rice", category: "food", pricePaise: 16000n, stockQty: 35 },
  { sku: "SKU_FOOD_011", title: "Veg Fried Rice", description: "Wok-tossed rice with mixed vegetables", category: "food", pricePaise: 12000n, stockQty: 40 },
  { sku: "SKU_FOOD_012", title: "Chicken Fried Rice", description: "Wok-tossed rice with chicken and vegetables", category: "food", pricePaise: 16000n, stockQty: 35 },
  { sku: "SKU_FOOD_013", title: "Paneer Roll", description: "Grilled paneer, onions, mint chutney in a paratha wrap", category: "food", pricePaise: 9000n, stockQty: 45 },
  { sku: "SKU_FOOD_014", title: "Chicken Roll", description: "Grilled chicken, onions, mint chutney in a paratha wrap", category: "food", pricePaise: 11000n, stockQty: 45 },
  { sku: "SKU_FOOD_015", title: "Samosa (2 pc)", description: "Crisp pastry, spiced potato filling", category: "food", pricePaise: 4000n, stockQty: 60 },
  { sku: "SKU_FOOD_016", title: "Vada Pav", description: "Spiced potato fritter in a soft bun, chutneys", category: "food", pricePaise: 3500n, stockQty: 60 },
  { sku: "SKU_FOOD_017", title: "Paneer Tikka (6 pc)", description: "Char-grilled marinated paneer skewers", category: "food", pricePaise: 17000n, stockQty: 30 },
  { sku: "SKU_FOOD_018", title: "Chicken Tikka (6 pc)", description: "Char-grilled marinated chicken skewers", category: "food", pricePaise: 21000n, stockQty: 30 },
  { sku: "SKU_FOOD_019", title: "Curd Rice", description: "Comfort-food rice tempered with curry leaves and mustard", category: "food", pricePaise: 8000n, stockQty: 40 },
  { sku: "SKU_FOOD_020", title: "Gulab Jamun (2 pc)", description: "Warm milk-solid dumplings in sugar syrup", category: "food", pricePaise: 6000n, stockQty: 50 },
  { sku: "SKU_BEV_001", title: "Masala Chai", description: "Spiced milk tea", category: "beverage", pricePaise: 3000n, stockQty: 100 },
  { sku: "SKU_BEV_002", title: "Filter Coffee", description: "South Indian filter coffee", category: "beverage", pricePaise: 3500n, stockQty: 100 },
  { sku: "SKU_BEV_003", title: "Fresh Lime Soda", description: "Sweet or salted, made to order", category: "beverage", pricePaise: 5000n, stockQty: 80 },
  { sku: "SKU_BEV_004", title: "Mango Lassi", description: "Yoghurt blended with mango pulp", category: "beverage", pricePaise: 7000n, stockQty: 60 },
  { sku: "SKU_BEV_005", title: "Packaged Water (1L)", description: "Sealed bottled drinking water", category: "beverage", pricePaise: 2000n, stockQty: 150 },
];

async function main() {
  await prisma.catalogItem.deleteMany({ where: { merchantId: MERCHANT_ID } });
  const { count } = await prisma.catalogItem.createMany({
    data: ITEMS.map((item) => ({ merchantId: MERCHANT_ID, ...item })),
  });
  console.log(`Seeded ${count} catalog items for merchant ${MERCHANT_ID}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
