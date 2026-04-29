# Product vs SKU — 電商系統的最基本資料模型

> **電商 / 零售 / 倉儲 系統設計的第一個分水嶺**：能不能正確分開「給 user 看的商品」和「給倉庫看的最小庫存單位」。搞混就會超賣。

## 核心定義

| 概念 | 定義 | 給誰看 |
|------|------|-------|
| **Product (產品)** | User 在商品頁看到的「我想買的東西」 | User、行銷、頁面渲染 |
| **SKU (Stock Keeping Unit)** | 倉庫實體上可獨立庫存、定價、出貨的最小單位 | 倉庫、ERP、財務 |

→ **一對多**：一個 Product 通常對應數十個 SKU（顏色 × 尺寸 × 規格的笛卡兒積）。

## 具體例子

Uniqlo「男性圓領 T 恤 (U001)」：
- 5 色 × 5 尺寸 = **25 SKU**
- 商品頁只有 1 個 Product，但庫存系統管理 25 條 SKU 記錄

不同行業 SKU 維度速查：

| 行業 | Product | SKU 維度 | 典型 SKU 數 |
|------|---------|---------|-------------|
| 服飾 | T 恤 | 顏色 × 尺寸 | 25-50 |
| 鞋類 | Nike AF1 | 顏色 × 尺寸（US/EU 雙標） | 30-80 |
| 食品 | 可口可樂 | 容量 × 包裝 × 口味 | 10-30 |
| 3C | iPhone 15 | 容量 × 顏色 × 機型 | 30-50 |
| 化妝品 | YSL 唇膏 | 色號 × 容量 | 50-150 |

→ 「100 萬 Product 對應 5000 萬 SKU」是常見比例，估算 storage / index 時要記得乘 N。

## 為什麼庫存粒度必須是 SKU

```
情境：客人要買「紅色 XXL T 恤」

❌ Product 粒度的庫存：
   "U001 T 恤" 庫存 = 800（25 個 SKU 加總）
   系統說「有貨」→ 接單成功
   倉庫去抓 → 紅色 XXL 早賣光，只剩白 M
   → 超賣事故，必須退款 + 道歉

✅ SKU 粒度的庫存：
   SKU U001-RED-XXL 庫存 = 0
   系統直接擋下單 → 不會超賣
```

**鐵律**：inventory table 的 PK 一定是 `sku_id`，不能是 `product_id`。

## 常見資料模型

```sql
-- Product：給 user 看的商品資訊（行銷層）
CREATE TABLE products (
  product_id    BIGINT PRIMARY KEY,
  name          VARCHAR(200),
  description   TEXT,
  brand         VARCHAR(100),
  category_id   BIGINT,
  base_price    DECIMAL(10,2)
);

-- SKU：庫存最小單位
CREATE TABLE skus (
  sku_id        VARCHAR(50) PRIMARY KEY,    -- "UNI-U001-WHT-M"
  product_id    BIGINT REFERENCES products,
  color         VARCHAR(20),
  size          VARCHAR(10),
  price         DECIMAL(10,2),               -- 各 SKU 可獨立定價（XXL 加價、限定色加價）
  weight_grams  INT,
  ean_code      VARCHAR(13)                  -- 國際條碼 (EAN-13)
);

-- Inventory：庫存以 SKU + Warehouse 為粒度
CREATE TABLE inventory (
  sku_id        VARCHAR(50),
  warehouse_id  BIGINT,
  quantity      INT,
  reserved      INT,                         -- 已被未付款訂單鎖定
  PRIMARY KEY (sku_id, warehouse_id)
);
```

## SKU 編碼設計

**結構化命名**（人類可讀，debug 友善）：
```
SKU = 品牌-款式-顏色-尺寸[-倉庫]
    = UNI-U001-WHT-M-TW01
```

**UUID / 自增 ID**（系統用，不需可讀性）：
```
SKU = "550e8400-e29b-41d4-a716-446655440000"
```

→ 大公司多用結構化（方便人工查詢、報表）；新創常用 UUID（簡單）。**重點是全公司唯一**。

## SKU vs 其他 ID 的關係

```
Product ID    : 商品頁 ID（給 user）
                U001 → "男性圓領 T 恤"

SKU ID        : 庫存單位 ID（給內部系統）
                UNI-U001-WHT-M-TW01

EAN / UPC     : 國際條碼（給掃碼機）
                4711234567890 → GS1 全球唯一

mapping:
  1 Product : N SKU
  1 SKU     : 1 EAN（如果有條碼商品）
  1 EAN     : 1 SKU（全球唯一）
```

## 設計時要問的 7 個問題

設計任何電商 / 倉儲 / OMS 系統時，至少回答這 7 題：

1. **Product 表跟 SKU 表分開了嗎？** 沒分開 → 重做
2. **Inventory 的 PK 是 sku_id 還是 product_id？** 必須是 sku_id
3. **同一 SKU 在不同倉庫的庫存怎麼存？** 通常是 `(sku_id, warehouse_id)` 複合 PK
4. **「reserved」(預扣) 庫存怎麼算？** 訂單未付款前 reserved += N，付款後 quantity -= N、reserved -= N，超時釋放 reserved
5. **價格是 Product 還是 SKU 層？** SKU 層（XXL 可能加價、限定色可能加價）
6. **促銷折扣套用在哪一層？** 通常是 Product 層宣告（「全色號 9 折」），實際扣款計算在 SKU 層
7. **預估 SKU 總數？** Product 數 × 平均 SKU/Product。Amazon 級別約 5 億 SKU、台灣電商約千萬 SKU

## 進階：SKU Variant 系統

成熟電商會有「Variant」這層 abstraction：

```
Product (款式)
  ├── Variant 維度: [Color, Size]   ← 哪些屬性會產生不同 SKU
  ├── Variant Options:
  │     Color: [White, Black, Red]
  │     Size: [S, M, L, XL]
  └── SKUs (笛卡兒積展開):
        White × S → SKU_001
        White × M → SKU_002
        ...
        Red × XL  → SKU_012
```

→ Shopify、Magento、WooCommerce 的核心 schema 都長這樣。

## 常見坑

1. **同 Product 不同 SKU 圖片不同**：紅色 T 恤照片 ≠ 白色 T 恤照片。圖片 URL 通常掛在 SKU 而不是 Product
2. **SKU 退場 (EOL)**：尺寸停產要 soft delete (status=discontinued)，不能 hard delete（歷史訂單會 broken FK）
3. **SKU 改規格** = 新建一個 SKU，不要改舊的（會影響歷史價格、報表、退貨識別）
4. **跨國電商**：同一 Product 不同國家可能 SKU 不同（包裝規格、語言、認證標籤）→ 加 `region` 維度
5. **Bundle 商品**（A + B 套裝）：本質是一個「虛擬 SKU」by composition，扣庫存時要拆成扣 A、扣 B 兩個動作

## 一句話記住

> **Product = 「我想買的東西」，SKU = 「倉庫架上具體那一格貨」。**
>
> User 挑「顏色 + 尺寸」= 從 Product 下鑽到具體 SKU。
> Inventory 扣的永遠是 SKU 的數量，不是 Product 的數量。
