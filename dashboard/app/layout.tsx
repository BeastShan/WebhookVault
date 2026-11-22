import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'WebhookVault | Delivery console',
  description: 'Inspect webhook deliveries, retry histories and incident evidence.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
