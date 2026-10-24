import { runMigrations } from './lib/persist'

import './styles/main.css'
import 'uno.css'

// Storage has to be in its current layout before any store module loads, and
// several read their keys at import time — so the app itself is imported only
// once migrations have run.
runMigrations()
void import('./bootstrap').then(m => m.mount())
