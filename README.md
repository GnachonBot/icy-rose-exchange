# Icy Rose Exchange — shop website

A clean mobile-friendly price and calculator website for your GTA RP exchange. No hosting bill or database required: it runs on **GitHub Pages**.

### Includes
- **Pawn Shop** — build a customer shopping cart, quantity and automatic sale total, optional per-sale price changes, copy order.
- **Buying Calculator** — buy materials/items from customers, exact fixed material buying prices and item-based buying offers, override price per transaction, copy payout order.
- **Cash Calculator** — enter Stacks and Rolls, set different unit values and see the combined total.
- **Items & Prices** — searchable catalogue with sell and buy prices, filter by Normal/Heist/Recycling/Materials, add items to carts.

The demo data is already loaded from the included latest corrected `MATS 1.0` Excel workbook. This website does not edit the workbook and does not require visitors to upload it.

## Deploy to GitHub (first time)

1. On [GitHub](https://github.com/new), create a repository, such as `icy-rose-exchange`. Choose **Public** for ordinary free GitHub Pages hosting.
2. Extract this ZIP and upload **all the project files and folders** to the repository using **Add file → Upload files**. IMPORTANT: include `.github/workflows/deploy.yml` (the dot-prefixed `.github` folder). If your upload method skips hidden folders, use Git or manually create the workflow file in GitHub.
3. On GitHub, open **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**.
4. Open the **Actions** tab and confirm the “Publish Icy Rose Exchange site” workflow has run. If necessary, choose **Run workflow**.
5. Your site will appear in **Settings → Pages**. For a normal project repo, the URL is `https://YOUR-USERNAME.github.io/icy-rose-exchange/`.

You only need to do this setup once.

## Update prices from a new Excel workbook (easiest method)

1. Make your changes in Excel and save the file as **.xlsx**.
2. In GitHub, go to the `source` folder in your repository, and replace **`prices.xlsx`** with your new workbook (same filename). Use **Add file → Upload files**, or edit/commit it with Git.
3. Commit the change to the `main` branch. GitHub Actions automatically converts the workbook into prices and republishes the site. The public price list and both carts update for everyone without editing code.

**If you prefer to upload your new workbook in ChatGPT:** send it in our conversation. I can update the generated data/project for you. The changed project (or updated `source/prices.xlsx`) still needs to be committed to your GitHub repo for everyone to see it.

## Pricing rules

| Product type | Public sale / Pawn Shop | Buying Calculator |
| --- | --- | --- |
| Crafted items | `Items & Prices` column F (custom selling price), otherwise **2× recipe cost** | Fixed offer in `Buying Calculator` column O if entered, otherwise per-item percentage in N, otherwise default percentage in P3 (currently **50%**) |
| Materials | `Materials & Prices` column J if set, otherwise column C | The **exact material buying price** from `Materials & Prices` column F (NOT 50%) |

If a Pawn Shop override is explicitly entered in `Pawn Shop` column L, it controls the Pawn Shop and public price-list selling amount. Separate on-page cart overrides change **only that one transaction** and are saved in that visitor's browser. Zero is a valid entered price; blank is shown as **Not set**. 

For presentation only, these names are displayed on the site without changing workbook formulas:
- `Boost USB` → **Blue USB**
- `Stolen Phone` → **S Phone**, `Stolen Radio` → **S Radio**
- `Oxy` → **Ox*** and `Oxy (50%)` → **Ox* (50%)**

## Test or change locally

Run from the project root (Python 3.9 or later):

```bash
python scripts/build_data.py source/prices.xlsx site/data/prices.json
python -m http.server 8000 --directory site
```

Open `http://localhost:8000`. Don't double-click `index.html`: browsers may block loading JSON from `file://`.

Project structure:

```text
.github/workflows/deploy.yml   Auto-build + publish to GitHub Pages
source/prices.xlsx             The Excel file you replace for updates
scripts/build_data.py         Converts workbook into public JSON
site/index.html               Site layout
site/styles.css               Icy Rose design
site/app.js                   Calculators and searchable list
site/data/prices.json         Generated data (rebuilt on deploy)
site/assets/icy-rose-logo.png Transparent-look Icy Rose branding
```

**Privacy:** The published Pages site contains item names, prices, and cached shop data, not the Excel workbook itself. The complete workbook is still stored in your GitHub repo under `source/prices.xlsx`; use a repository with appropriate visibility and do not put private data in the workbook. GitHub Pages websites are publicly accessible even when private repository Pages hosting is supported.
