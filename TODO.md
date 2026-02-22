# 🌌 ДОКТРИНА "TITANIUM CORE": ЭНДГЕЙМ АРХИТЕКТУРА (Резерв)

## ПРИКАЗ: "CQRS ORCHESTRATION & TAURI DECAPITATION" (УДАР 1 / TC-1)

**Проблема:**
Папка `apps/desktop_host` является свалкой бизнес-логики. Файлы `clip_mutators.rs` (3217 LOC), `plugins_routing.rs` (2861 LOC) и `lib.rs` (4006 LOC) грубо нарушают архитектуру. Tauri — это только транспортный слой (IPC-мост), а не мозг DAW.

**Задача:** Переход на паттерн **CQRS (Command/Query Responsibility Segregation)**.

### ШАГ 1: Создание `core/dream_orchestrator`
1. Крейт `core/dream_orchestrator` создан (357 LOC). В нем определены строгие трейты контекста (`SnapshotRebuilder`, `UndoManager`, `DirtyMarker`), чтобы отвязать бизнес-логику от Tauri.
2. Реализованы заглушки заглушки команд.

### ШАГ 2: Расчленение `clip_mutators.rs`
1. Перенести ВСЮ логику из `clip_mutators.rs` в `dream_orchestrator/src/commands/`.
2. В файлах команд (например, `clip_split.rs`) необходимо напрямую вызывать `ctx.push_undo()`, `ctx.snapshots.rebuild()` и `ctx.mark_dirty_from_project()`.
3. В Tauri-хэндлерах (в `desktop_host`) оставить только: десериализация аргументов -> вызов `ctx.execute(SplitClipCommand { ... })` -> возврат результата.

### ШАГ 3: Расчленение `plugins_routing.rs`
1. Перенести логику перестроения графа плагинов в `core/dream_graph/src/routing/` (или в оркестратор).
2. Разбить на логические модули: `chain_builder.rs`, `bus_allocator.rs`, `send_return.rs`.

### ШАГ 4: Зачистка `desktop_host/src/lib.rs`
1. Вынести инициализацию глобального стейта (`ProjectState`, `PluginHostState`, `AudioEngineHandle` и др.) в `apps/desktop_host/src/state_managers/`.
2. Именно в `state_managers/` должны быть реализованы трейты из оркестратора (например, `TauriUndoManager` будет вызывать логику Tauri-стэйта).
3. Вынести настройку меню в `menu.rs`.
4. В `lib.rs` должен остаться только список `tauri::generate_handler![]`, базовый setup и макрос `tauri::Builder`.

---

**Результат:**
Tauri становится 100% легковесным IPC-шлюзом. Вся логика, undo/redo, перестроение графа и dirty-маркеры инкапсулируются в `dream_orchestrator`. Это открывает путь к Headless DAW, CLI-рендерингу и тотальному покрытию unit-тестами без запуска GUI-цикла.
