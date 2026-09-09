# DESIGN SYSTEM SPECIFICATION: RIZURF COLOR SCHEME
---
## 1. COLOR PALETTE & HEX CODES

| Category | Token / Variable | Hex Code | Visual Description / Role |
| :--- | :--- | :--- | :--- |
| **Brand Colors** | `--brand-dark` | `#021732` | Dark Navy (Primary Brand / Banner BG) |
| | `--brand-navy` | `#0A2A4E` | Deep Navy (Accent Dark / Primary Buttons) |
| | `--brand-teal-dark` | `#027E8F` | Dark Teal |
| | `--brand-teal` | `#039DB1` | Bright Teal Accent |
| | `--brand-teal-light` | `#0A2A4E` | Light Muted Teal Tint |
| | `--brand-ice` | `#E7F6F8` | Ice Blue / Light Soft Background Tint |
| **Neutral Colors** | `--neutral-dark` | `#0E1B2C` | Deep Slate / Dark Text Header Color |
| | `--neutral-gray` | `#5A6B80` | Muted Gray Text / Secondary Label Color |
| | `--neutral-border` | `#E3E8EF` | Light Gray Border / Outline Color |
| | `--neutral-white` | `#FFFFFF` | Pure White Background |
| | `--neutral-bg` | `#F6F8FB` | Soft Slate Canvas / Page Background |
| **Status Colors** | `--status-success` | `#12A150` | Green (Success / Available / Verified) |
| | `--status-warning` | `#E8A317` | Amber / Gold (Pending / Alert) |
| | `--status-danger` | `#E0533D` | Coral Red (Error / Unavailable / Important) |

---

## 2. TYPOGRAPHY & FONTS

* **Font Family:** `Inter`, `sans-serif`

### Hierarchy & Scale

* **H1:** `28px` | Weight: `700` (Bold)
* **H2:** `16px` | Weight: `700` (Bold)
* **H3:** `14px` | Weight: `700` (Bold)
* **Paragraph:** `13.5px` | Weight: `500` (Medium)
* **Secondary Text:** `12.5px` | Weight: `500` (Medium)
* **Button Label:** `14px` | Weight: `650` (Semi-Bold)

---

## 3. BUTTONS & UI SHAPES

* **Button Shape:** Fully rounded pill container (`border-radius: 9999px`)
* **Default Button Background:** `#0E1B2C` or `#0A2A4E`
* **Default Button Text:** `#FFFFFF` | `14px` | Weight: `650`

---

## 4. CSS DESIGN TOKENS (VARIABLES)

```css
:root {
  /* Brand Colors */
  --brand-dark: #021732;
  --brand-navy: #0a2a4e;
  --brand-teal-dark: #027e8f;
  --brand-teal: #039db1;
  --brand-teal-light: #0a2a4e;
  --brand-ice: #e7f6f8;

  /* Neutral Colors */
  --neutral-dark: #0e1b2c;
  --neutral-gray: #5a6b80;
  --neutral-border: #e3e8ef;
  --neutral-white: #ffffff;
  --neutral-bg: #f6f8fb;

  /* Status Colors */
  --status-success: #12a150;
  --status-warning: #e8a317;
  --status-danger: #e0533d;

  /* Typography */
  --font-family-base: 'Inter', system-ui, -apple-system, sans-serif;
  --font-size-h1: 28px;
  --font-size-h2: 16px;
  --font-size-h3: 14px;
  --font-size-p: 13.5px;
  --font-size-secondary: 12.5px;
  --font-size-btn: 14px;

  /* Shapes */
  --radius-pill: 9999px;
}

/* Global Typography Classes */
body {
  font-family: var(--font-family-base);
  color: var(--neutral-dark);
  background-color: var(--neutral-bg);
}

h1 {
  font-size: var(--font-size-h1);
  font-weight: 700;
  color: var(--neutral-dark);
}

h2 {
  font-size: var(--font-size-h2);
  font-weight: 700;
  color: var(--neutral-dark);
}

h3 {
  font-size: var(--font-size-h3);
  font-weight: 700;
  color: var(--neutral-dark);
}

p {
  font-size: var(--font-size-p);
  font-weight: 500;
  color: var(--neutral-dark);
}

.text-secondary {
  font-size: var(--font-size-secondary);
  font-weight: 500;
  color: var(--neutral-gray);
}

.btn-rizurf {
  background-color: var(--neutral-dark);
  color: var(--neutral-white);
  font-size: var(--font-size-btn);
  font-weight: 650;
  padding: 10px 24px;
  border-radius: var(--radius-pill);
  border: none;
  cursor: pointer;
}