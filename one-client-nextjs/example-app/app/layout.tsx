import './globals.css';
import { EarthoProvider } from '@eartho/one-client-nextjs/client';
import Nav from '@/app/nav';

export const metadata = {
  title: 'Create Next App',
  description: 'Generated by create next app'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <EarthoProvider>
        <body>
          <header>
            <Nav />
          </header>
          <div className="container">{children}</div>
        </body>
      </EarthoProvider>
    </html>
  );
}