import type React from 'react'

/**
 * Payload-админка рендерит собственные `<html>/<body>` через `RootLayout`.
 * Сюда нельзя класть разметку лендинга — она оказалась бы ВНЕ payload-html
 * и дала бы hydration-ошибку.
 */
const Layout = ({ children }: { children: React.ReactNode }) => children

export default Layout
