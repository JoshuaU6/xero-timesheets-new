import './globals.css'
import { Providers } from './providers'

export const metadata = {
  title: 'Xero Timesheets',
  description: 'Timesheet processing app',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}


