import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Azure Secret Expiration Dashboard",
  description: "Internal Azure and Entra credential expiration worklist"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
