# 🤖 Dream DAW AI Agent — Test & Interaction Guide

> **Цель документа**: Полное руководство по тестированию, взаимодействию и оценке AI-агента Dream DAW.  
> **Последнее обновление**: 2026-02-22

---

## 1. Архитектура AI-агента

### Стек
| Компонент | Технология |
|-----------|------------|
| LLM API | OpenRouter → Claude/GPT |
| Streaming | SSE (Server-Sent Events) |
| Tool Execution | Chain-of-Thought с 8-уровневым циклом |
| Frontend UI | React (AgentActionCard + LiveAgentCard) |
| Backend IPC | Tauri commands (Rust → TypeScript) |
| State | Zustand (useEngineStore, useAgentActionStore) |

### Поток данных
```
User Message → buildSystemPrompt() → OpenRouter API (stream)
     ↓                                      ↓
Chat UI ← StreamEvent ← SSE chunks ← tool_calls (parsed)
     ↓                                      ↓
Action Cards ← executeTool() → engineApi → Tauri IPC → Rust Engine
     ↓                                      ↓
Auto-scroll ← tool-end event ← result → conversation.push(tool_result)
     ↓                                      ↓
Final Response ← done event ← next API loop iteration (depth++)
```

### Ограничения
| Параметр | Значение |
|----------|----------|
| `MAX_TOOL_DEPTH` | 8 итераций (потом принудительный `done`) |
| `max_tokens` | 4096 на один API-запрос |
| `TOOLS` | ~55 инструментов |
| Batch размер | Без лимита (но IPC может тормозить на 100+) |

---

## 2. Полный список инструментов (55)

### 🔍 Инспекция (5)
- `get_project_overview` — полный обзор проекта (треки, BPM, SR)
- `get_track_clips` — клипы на конкретном треке
- `get_clip_details` — детали клипа по UUID
- `get_transport_state` — состояние транспорта
- `get_metering` — RMS/Peak метринг всех треков

### 🎵 Аудио & MIDI (6)
- `add_midi_track` — создать MIDI-трек
- `create_midi_clip` — создать MIDI-клип на треке (с позицией и длительностью в битах)
- `set_clip_notes` — записать MIDI-ноты в клип
- `search_browser` — искать аудиосемплы по ключевому слову
- `add_sample_to_rack` — загрузить семпл в Drum Rack (pad + track)
- `add_audio_clip` — поместить аудиосемпл на аудио-трек по beat-позиции

### 🎹 Музыкальная теория (5)
- `generate_chord` — вычислить MIDI-ноты аккорда (root + type: min7, maj, etc.)
- `generate_scale` — вычислить все ноты шкалы
- `generate_arpeggio` — создать арпеджио-паттерн
- `quantize_notes` — квантизировать ноты в клипе
- `humanize_velocity` — гуманизировать velocity (±range)

### 🥁 Drum Rack (5)
- `set_pad_volume` — громкость пэда
- `set_pad_mute` — мьют пэда
- `set_pad_adsr` — ADSR огибающая пэда (attack, decay, sustain, release)
- `set_pad_filter_cutoff` — частота среза фильтра пэда
- `preview_note` — прослушать ноту/пэд

### 🎛️ Треки (9)
- `add_track` — добавить аудио-трек
- `rename_track` — переименовать
- `delete_track` — удалить
- `set_track_volume` — громкость (0.0–1.5)
- `set_track_pan` — панорама (-1.0 … +1.0)
- `set_track_mute` — мьют
- `set_track_solo` — соло
- `set_track_color` — цвет (hex)
- `create_track_group` — группа треков

### ✂️ Клипы (9)
- `select_clips` — выделить клипы по ID
- `select_all_clips_on_track` — выделить все в треке
- `delete_clip` — удалить 1 клип
- `set_clip_muted` — мьют клипа
- `move_clip` — переместить (трек + beat)
- `duplicate_clip` — дублировать
- `split_clip` — разрезать на beat-позиции
- `merge_clips` — объединить клипы
- `set_clip_fade` — fade in/out (мс)

### 🔊 Транспорт & Mix (7)
- `transport_play` / `transport_stop` — воспроизведение
- `set_bpm` — установить BPM
- `seek_to_beat` — перемотать к биту
- `set_master_volume` — мастер-громкость
- `set_loop_region` — зона лупа (start/end beats)
- `undo` / `redo` — отмена/повтор

### 🧩 Эффекты (4)
- `add_effect` — добавить эффект (EQ, Compressor, Reverb, Delay, etc.)
- `remove_effect` — удалить
- `set_effect_parameter` — установить параметр эффекта
- `bypass_effect` — вкл/выкл обход

### 🤖 AI Mixing (2)
- `auto_gain_stage` — автоматическая нормализация всех треков к -3dB
- `auto_cleanup_mix` — авто-добавление HP-фильтра на не-басовые треки

### 🎼 Arrangement (1)
- `suggest_arrangement` — AI предлагает структуру трека (Intro, Drop, Outro)

### ⚡ Batch (3)
- `add_audio_clips_batch` — пакетное добавление аудиоклипов (массив)
- `delete_clips_batch` — пакетное удаление клипов
- `delete_all_clips_on_track` — удалить все клипы на треке

---

## 3. Как правильно формулировать запросы

### ❌ ПЛОХО (неэффективные запросы)
```
"Сделай музыку"              → Слишком абстрактно, агент не знает жанр/темп/структуру
"Добавь кик"                 → Не ясно на какой трек, с какой частотой
"Поменяй звучание"           → Что именно? Громкость? Эффект? Панораму?
```

### ✅ ХОРОШО (эффективные запросы)

#### Создание трека с нуля
```
"Создай House трек 128 BPM:
 - Kick на каждый бит (0, 1, 2, 3) 
 - Closed hat на оффбиты (0.5, 1.5, 2.5, 3.5)
 - Clap на 1 и 3
 - Sub bass на E1 (ноты: E1-G1-A1-B1 по кругу)
 - 16 баров"
```

#### Запрос на аранжировку
```
"Проанализируй текущий проект и предложи аранжировку в стиле Progressive House:
 - Intro 8 баров
 - Build-up 8 баров  
 - Drop 16 баров
 - Breakdown 8 баров
 - Second Drop 16 баров
 - Outro 8 баров"
```

#### Сведение
```
"Сведи текущий микс:
 1. auto_gain_stage все треки
 2. Добавь HP фильтр на не-басовые треки
 3. Покажи метринг
 4. Если пики > -1dB, убавь мастер"
```

#### Drum Design
```
"Настрой Drum Rack:
 - Kick (pad 0): attack=0, decay=0.6, sustain=0.2, release=0.3, filter cutoff=8000
 - Clap (pad 1): attack=0.01, decay=0.4, sustain=0, release=0.2
 - Hat (pad 6): attack=0, decay=0.15, sustain=0, release=0.1, filter cutoff=12000"
```

---

## 4. Паттерны запросов по жанрам

### House (128 BPM)
```
"Create a full house track at 128 BPM, 32 bars:
 Track 1 (DRM_Kick): Kick on every beat
 Track 2 (DRM_Perc): Clap on beats 1, 3; Closed hat on every offbeat
 Track 3 (BASS_Sub): Sub bass E1, 1-bar pattern, 4/4
 Track 4 (SYN_Pad): Amin7 chord pad, sustained 4 bars
 Use batch ops. Color-code tracks. auto_gain_stage at the end."
```

### Techno (135 BPM)
```
"Create a techno track at 135 BPM, 32 bars:
 Hard kick on every beat, short decay
 Hi-hat 16th notes pattern
 Clap every 1 and 3 with reverb
 Acid bass pattern (303 style) in A minor
 HP filter on everything except kick"
```

### Lo-fi Hip-Hop (85 BPM)
```
"Create lo-fi hip-hop 85 BPM, 16 bars:
 Boom-bap kick on 0, 2.5 (swing)
 Snare on 1, 3
 Hat triplets 
 Piano chord progression Cmaj7 - Am7 - Dm7 - G7
 humanize_velocity ±20 for all drums"
```

---

## 5. Тестовые сценарии

### Test 1: Базовый House (критический)
**Запрос**: `"Создай House трек 128 BPM, 16 баров с kick, clap, hi-hat, bass. Используй batch операции."`

**Ожидаемое поведение**:
1. Агент ставит BPM → 128
2. Ищет семплы: `search_browser("kick")`, `search_browser("clap")`, `search_browser("hat")`
3. Создаёт треки: `add_midi_track` или `add_track` для каждого инструмента
4. Использует `add_audio_clips_batch` для кика (64 клипа: 16 баров × 4 бита)
5. Добавляет clap и hat паттерны пакетно
6. Создаёт MIDI-трек для баса, пишет ноты
7. Финальное сведение: `auto_gain_stage`, `set_track_color`

**Критерии оценки**:
- [ ] Все треки созданы
- [ ] Семплы найдены и загружены
- [ ] Паттерны ритмически корректны (kick на 0,1,2,3)
- [ ] Batch операции использованы (не 64 отдельных вызова)
- [ ] Финальное сообщение есть и видно
- [ ] UI не крашнулся

### Test 2: MIDI Chord Progression
**Запрос**: `"Создай аккордовую прогрессию Am7 - Dm7 - G7 - Cmaj7 на SYN_Pad треке, 4 бара"`

**Ожидаемое поведение**:
1. `add_midi_track("SYN_Pad")`
2. `generate_chord(57, "min7")` → [57, 60, 64, 67]
3. `create_midi_clip(trackIdx, 0, 16)`
4. `set_clip_notes` с 4 аккордами по 4 бита каждый

### Test 3: Mix Analysis
**Запрос**: `"Проанализируй микс и исправь проблемы"`

**Ожидаемое поведение**:
1. `get_project_overview`
2. `get_metering`
3. `auto_gain_stage`
4. `auto_cleanup_mix`
5. Повторный `get_metering` для проверки

### Test 4: Error Handling
**Запрос**: `"Добавь kick семпл на трек 99"`

**Ожидаемое поведение**:
- Агент должен gracefully обработать ошибку (трек не существует)
- Предложить создать трек сначала или использовать существующий

---

## 6. Оценка и известные ограничения

### ✅ Сильные стороны
1. **55 инструментов** — покрывает весь DAW workflow
2. **Batch операции** — 10x быстрее, предотвращает крэши  
3. **Динамический system prompt** — передаёт текущее состояние проекта (треки, BPM, клипы)
4. **Chain-of-Thought** — агент объясняет решения
5. **Музыкальная теория** — генерация аккордов, шкал, арпеджио
6. **AI Mixing** — auto_gain_stage, auto_cleanup_mix

### ⚠️ Текущие ограничения
| Ограничение | Влияние | Потенциальное решение |
|-------------|---------|----------------------|
| `max_tokens: 4096` | Обрезает длинные ответы | Увеличить до 8192 |
| `MAX_TOOL_DEPTH: 8` | Сложные задачи не завершаются | Увеличить до 12–16 |
| Нет `generate_beat_pattern` | Агент вручную расписывает ноты | Добавить шаблоны паттернов |
| Нет аудио-генерации | Зависит от имеющихся семплов | Интеграция Suno/ACE |
| `search_browser` — только простой includes | Плохой fuzzy match | Использовать Levenshtein / TF-IDF |
| Batch всё ещё sequential `for..of` с `await` | Медленнее чем нужно | Использовать `Promise.allSettled` с throttle |
| Нет `duplicate_track` | Нельзя клонировать трек целиком | Добавить инструмент |
| Нет `set_track_routing` | Нельзя менять routing (bus, send) | Добавить инструмент |

### 🔴 Критические баги (исправлены)
1. **Audio distortion** — `source_to_timeline_rate` использовал device SR вместо project SR → FIXED
2. **Streaming warped path** — пропущен `source_to_timeline_rate` множитель → FIXED
3. **Пропадающее финальное сообщение** — агент не показывал итог → FIXED (auto-generated summary)

---

## 7. System Prompt — Ключевые секции

Системный промпт строится динамически (`buildSystemPrompt()`) и включает:

1. **Identity** — "Dream AI, autonomous musical co-author"
2. **AI Producer Manifesto** — Enterprise hygiene, explainability, music theory
3. **Current Project State** — BPM, SR, tracks, clips (live data from Zustand store)
4. **Tool Table** — 9 категорий с перечислением
5. **Behavior Rules**:
   - Chain-of-Thought обязателен
   - Drum Programming rules (Pad mapping: Kick=36, Clap=37, Hat=42)
   - Music Theory Engine usage
   - Intelligent Mixing workflow
   - **CRITICAL: Batch Operations preference**

---

## 8. Чек-лист для следующего тестирования

```markdown
## Пре-условия
- [ ] `cargo tauri dev` запущен и скомпилирован
- [ ] OpenRouter API Key установлен в Settings
- [ ] Модель выбрана (рекомендуется: claude-sonnet-4-20250514)

## Тест
- [ ] Открыть AI Chat (иконка или Cmd+K)
- [ ] Отправить запрос на House трек (см. Test 1 выше)
- [ ] Наблюдать:
  - [ ] Появляется LiveAgentCard с thinking?
  - [ ] Action карточки обновляются в реальном времени?
  - [ ] Auto-scroll работает мгновенно?
  - [ ] Batch операции используются (одна карточка с "Add 64 clips")?
  - [ ] Финальное сообщение видно и не пропадает?
  - [ ] Copy кнопка на заголовке карточки работает?
  - [ ] Toast уведомления корректны?
- [ ] Нажать Play и проверить звучание:
  - [ ] Правильный pitch (не ниже/выше)?
  - [ ] Нет треска/артефактов?
  - [ ] Паттерн ритмически корректен?
```
