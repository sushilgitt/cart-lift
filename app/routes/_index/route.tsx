import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>CartLift: bundles &amp; quantity breaks</h1>
        <p className={styles.text}>
          Raise average order value with “buy more, save more” offers right on the product page.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Quantity breaks</strong>. Buy 1, buy 2 save 10%, buy 3 save 20% — shown as tap-to-select bars.
          </li>
          <li>
            <strong>BOGO, gifts &amp; upsells</strong>. Buy X get Y, free gifts per tier and one-click add-ons.
          </li>
          <li>
            <strong>Native checkout pricing</strong>. Discounts are applied by Shopify Functions — no draft orders, no
            duplicate products.
          </li>
        </ul>
        <p className={styles.text}>
          <a href="/privacy">Privacy policy</a>
        </p>
      </div>
    </div>
  );
}
