/**
 * dsh-qqmail — minimal in-process SMTP and IMAP servers for end-to-end tests.
 *
 * These implement exactly what nodemailer and imapflow need, so the plugin's
 * real code paths (ImapSession, composeMessage, sendComposed, MailService) run
 * over a real socket instead of being mocked away. A mock would happily accept
 * a wrong command sequence; these servers answer only what a real server would.
 *
 * Conservative on purpose: no IMAP extensions are advertised (no IMAP4rev2,
 * ENABLE, MOVE, UIDPLUS, SPECIAL-USE, ID). imapflow then uses plain IMAP4rev1
 * commands and COPY + STORE + EXPUNGE for moves — the same fallback that runs
 * against a provider without SPECIAL-USE, which is precisely the branch worth
 * testing.
 */

import net from 'node:net'

/** Frame one response out of strings and Buffers without splitting a literal. */
function frame(...parts) {
  return Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'utf8') : part)))
}

/** IMAP quoted string (JSON escaping is compatible for the ASCII we emit). */
function q(value) {
  return value === '' ? 'NIL' : JSON.stringify(value)
}

/**
 * Start a fake SMTP server.
 * @returns {Promise<{port:number, messages:string[], close:()=>Promise<void>}>}
 */
export async function startFakeSmtp() {
  const messages = []
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = ''
    let inData = false
    let data = ''
    socket.write('220 fake.local ESMTP ready\r\n')
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\r\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            messages.push(data)
            data = ''
            socket.write('250 2.0.0 Ok: queued\r\n')
          } else {
            // RFC 5321 dot-stuffing: a leading "." arrives doubled.
            data += (line.startsWith('..') ? line.slice(1) : line) + '\r\n'
          }
        } else {
          const upper = line.toUpperCase()
          if (upper.startsWith('EHLO')) {
            socket.write('250-fake.local\r\n250-SIZE 52428800\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n')
          } else if (upper.startsWith('HELO')) {
            socket.write('250 fake.local\r\n')
          } else if (upper.startsWith('AUTH')) {
            socket.write('235 2.7.0 Authentication successful\r\n')
          } else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) {
            socket.write('250 2.1.0 Ok\r\n')
          } else if (upper === 'DATA') {
            inData = true
            data = ''
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
          } else if (upper === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n')
            socket.end()
          } else {
            socket.write('250 2.0.0 Ok\r\n')
          }
        }
        index = buffer.indexOf('\r\n')
      }
    })
    socket.on('error', () => undefined)
  })
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return {
    port,
    messages,
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
  }
}

/**
 * Start a fake IMAP server.
 * @param {object} options - { user, password, folders, messages }
 * @returns {Promise<object>} handle with recorded mutations and command log
 */
export async function startFakeImap(options = {}) {
  const user = options.user ?? 'me@qq.com'
  const password = options.password ?? 'secret-auth-code'
  const folders = options.folders ?? [
    { path: 'INBOX', flags: [] },
    { path: 'Sent Messages', flags: [] },
    { path: 'Drafts', flags: [] },
    { path: 'Deleted Messages', flags: [] },
    { path: 'Junk', flags: [] },
    { path: 'Archive', flags: ['\\Noselect'] },
  ]
  /** folder path → message list (each { uid, raw, flags:Set }) */
  const messages = new Map()
  for (const [folder, list] of Object.entries(options.messages ?? {})) {
    messages.set(
      folder,
      list.map((entry, index) => ({
        uid: entry.uid ?? index + 1,
        raw: Buffer.isBuffer(entry.raw) ? entry.raw : Buffer.from(String(entry.raw), 'utf8'),
        flags: new Set(entry.flags ?? []),
      })),
    )
  }
  const appended = []
  const stores = []
  const moves = []
  const copies = []
  const commands = []
  const sockets = new Set()

  const listFor = (path) => messages.get(path) ?? []
  const folderOf = (path) => folders.find((entry) => entry.path === path)

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)

    let buffer = Buffer.alloc(0)
    /** Pending APPEND awaiting its literal. */
    let pendingAppend = null
    let selected = ''

    /** Resolve an IMAP set ("1,2", "1:3", "1:*", "*") to UIDs. */
    const resolveSet = (spec, path) => {
      const list = listFor(path)
      const all = list.map((entry) => entry.uid).sort((a, b) => a - b)
      if (spec === '' || spec === '*') return all
      const out = new Set()
      for (const part of spec.split(',')) {
        const [from, to] = part.split(':')
        if (to === undefined) {
          out.add(Number(from))
          continue
        }
        const start = Number(from)
        const end = to === '*' ? (all[all.length - 1] ?? 0) : Number(to)
        for (const uid of all) if (uid >= start && uid <= end) out.add(uid)
      }
      return [...out].filter((uid) => Number.isFinite(uid)).sort((a, b) => a - b)
    }

    /** Split "Name <addr@host>" (or a bare address) into ENVELOPE address fields. */
    const addressFields = (value) => {
      if (value === '') return 'NIL'
      const angled = /<([^>]+)>/.exec(value)
      const address = (angled !== null ? angled[1] : value).trim()
      const name = value.replace(/<[^>]*>/, '').replace(/^"|"$/g, '').trim()
      const at = address.lastIndexOf('@')
      const mailbox = at >= 0 ? address.slice(0, at) : address
      const host = at >= 0 ? address.slice(at + 1) : ''
      return '(' + q(name) + ' NIL ' + q(mailbox) + ' ' + q(host) + ')'
    }

    const headerOf = (raw, name) => new RegExp('^' + name + ':\\s*(.*)$', 'mi').exec(raw)?.[1]?.trim() ?? ''

    /** Full ENVELOPE for one message, read out of its raw headers. */
    const envelopeOf = (entry) => {
      const raw = entry.raw.toString('utf8')
      const from = addressFields(headerOf(raw, 'From'))
      const to = addressFields(headerOf(raw, 'To'))
      return (
        '(' +
        q(headerOf(raw, 'Date')) +
        ' ' +
        q(headerOf(raw, 'Subject')) +
        ' (' + from + ') (' + from + ') (' + from + ')' +
        ' (' + to + ')' +
        ' NIL NIL NIL ' +
        q(headerOf(raw, 'In-Reply-To')) +
        ' ' +
        q(headerOf(raw, 'Message-ID')) +
        ')'
      )
    }

    /** FETCH response body for one message. */
    const fetchResponse = (entry, seq, query, uidMode) => {
      const fields = []
      if (query.uid) fields.push('UID ' + String(entry.uid))
      if (query.envelope) fields.push('ENVELOPE ' + envelopeOf(entry))
      if (query.flags) fields.push('FLAGS (' + [...entry.flags].join(' ') + ')')
      if (query.size) fields.push('RFC822.SIZE ' + String(entry.raw.length))
      if (query.bodyStructure) {
        const rawText = entry.raw.toString('utf8')
        const lines = rawText.split('\r\n').length
        if (/^Content-Type:\s*multipart\//mi.test(rawText)) {
          // A multipart/mixed layout: a text body plus one attachment part, so
          // the plugin's hasAttachments probe has something real to find.
          fields.push(
            'BODYSTRUCTURE (' +
              '("text" "plain" ("charset" "utf-8") NIL NIL "7bit" 20 2) ' +
              '("application" "octet-stream" ("name" "report.txt") NIL NIL "base64" 40 NIL ("attachment" ("filename" "report.txt"))) ' +
              '"mixed")',
          )
        } else {
          fields.push(
            'BODYSTRUCTURE ("text" "plain" ("charset" "utf-8") NIL NIL "7bit" ' +
              String(entry.raw.length) + ' ' + String(lines) + ')',
          )
        }
      }
      const literals = []
      if (query.previewBytes > 0) {
        // BODY[1] on a single-part message is the body *without* its headers.
        const headerEnd = entry.raw.indexOf('\r\n\r\n')
        const body = headerEnd >= 0 ? entry.raw.subarray(headerEnd + 4) : entry.raw
        const slice = body.subarray(0, query.previewBytes)
        literals.push(frame(' BODY[1]<0> {', String(slice.length), '}\r\n', slice))
      }
      if (query.source) {
        literals.push(frame(' BODY[] {', String(entry.raw.length), '}\r\n', entry.raw))
      }
      const id = uidMode ? entry.uid : seq
      return [frame('* ', String(id), ' FETCH (', fields.join(' '), ...literals, ')\r\n')]
    }

    /** Which FETCH items the client asked for. */
    const parseFetchQuery = (text) => {
      const upper = text.toUpperCase()
      const partial = /BODY(?:\.PEEK)?\[1\]<(\d+)\.(\d+)>/.exec(upper)
      return {
        uid: /\bUID\b/.test(upper),
        envelope: /\bENVELOPE\b/.test(upper),
        flags: /\bFLAGS\b/.test(upper),
        size: /RFC822\.SIZE/.test(upper),
        bodyStructure: /BODYSTRUCTURE/.test(upper),
        source: /BODY(?:\.PEEK)?\[\]/.test(upper),
        previewBytes: partial !== null ? Number(partial[2]) : 0,
      }
    }

    const handleLine = (line) => {
      commands.push(line)
      const spaceAt = line.indexOf(' ')
      const tag = spaceAt >= 0 ? line.slice(0, spaceAt) : line
      const rest = spaceAt >= 0 ? line.slice(spaceAt + 1) : ''
      const upper = rest.toUpperCase()

      if (upper.startsWith('CAPABILITY')) {
        socket.write(frame('* CAPABILITY IMAP4rev1\r\n' + tag + ' OK CAPABILITY completed\r\n'))
        return
      }
      if (upper.startsWith('LOGIN')) {
        const parts = rest.split(' ')
        const givenUser = (parts[1] ?? '').replace(/^"|"$/g, '')
        const givenPass = (parts[2] ?? '').replace(/^"|"$/g, '')
        if (givenUser === user && givenPass === password) socket.write(frame(tag + ' OK LOGIN completed\r\n'))
        else socket.write(frame(tag + ' NO [AUTHENTICATIONFAILED] Authentication failed\r\n'))
        return
      }
      if (upper.startsWith('LOGOUT')) {
        socket.write(frame('* BYE Logging out\r\n' + tag + ' OK LOGOUT completed\r\n'))
        socket.end()
        return
      }
      if (upper.startsWith('NOOP')) {
        socket.write(frame(tag + ' OK NOOP completed\r\n'))
        return
      }
      if (upper === 'ID' || upper.startsWith('ID ')) {
        socket.write(frame('* ID NIL\r\n' + tag + ' OK ID completed\r\n'))
        return
      }
      if (upper.startsWith('NAMESPACE')) {
        socket.write(frame('* NAMESPACE (("" "/")) NIL NIL\r\n' + tag + ' OK NAMESPACE completed\r\n'))
        return
      }
      if (upper.startsWith('LIST')) {
        // Honour the LIST reference+pattern. imapflow issues a follow-up
        // `LIST "<special>/" "*"` for every special-use folder it recognises, so
        // a server that ignores the arguments makes it prefix *every* mailbox
        // with that folder's name (e.g. "Archive/Sent Messages").
        // `rest` still carries the command word, so strip it before parsing args.
        const listArgs = rest.replace(/^LIST\s*/i, '').trim()
        const parsed = /^"([^"]*)"\s+"?([^"\s]*)"?\s*$/.exec(listArgs)
        const reference = parsed?.[1] ?? ''
        const pattern = parsed?.[2] ?? ''
        // `LIST "" ""` is the hierarchy-delimiter probe. Answer it with no rows:
        // the delimiter is already carried by the real LIST rows, and an empty
        // path row confuses clients that treat every returned path as a mailbox.
        if (reference === '' && pattern === '') {
          socket.write(frame(tag + ' OK LIST completed\r\n'))
          return
        }
        const matcher = new RegExp(
          '^' +
            (reference + pattern)
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/%/g, '[^/]*') +
            '$',
        )
        const lines = folders
          .filter((folder) => matcher.test(folder.path))
          .map(
            (folder) =>
              '* LIST (' +
              (folder.flags.length > 0 ? folder.flags.join(' ') : '\\HasNoChildren') +
              ') "/" "' +
              folder.path +
              '"',
          )
        socket.write(frame((lines.length > 0 ? lines.join('\r\n') + '\r\n' : '') + tag + ' OK LIST completed\r\n'))
        return
      }
      if (upper.startsWith('LSUB')) {
        socket.write(frame('* LSUB () "/" "INBOX"\r\n' + tag + ' OK LSUB completed\r\n'))
        return
      }
      if (upper.startsWith('STATUS')) {
        // The mailbox may be quoted or a bare atom: imapflow sends it unquoted.
        const statusArgs = rest.replace(/^STATUS\s*/i, '').trim()
        const statusPath = /^"([^"]*)"|^([^\s(]+)/.exec(statusArgs)
        const path = statusPath?.[1] ?? statusPath?.[2] ?? ''
        const list = listFor(path)
        const unseen = list.filter((entry) => !entry.flags.has('\\Seen')).length
        socket.write(
          frame(
            '* STATUS "' + path + '" (MESSAGES ' + String(list.length) + ' UNSEEN ' + String(unseen) + ')\r\n' +
              tag + ' OK STATUS completed\r\n',
          ),
        )
        return
      }
      if (upper.startsWith('SELECT') || upper.startsWith('EXAMINE')) {
        const path = /"([^"]*)"/.exec(rest)?.[1] ?? rest.split(' ').pop() ?? ''
        const folder = folderOf(path)
        if (folder === undefined) {
          socket.write(frame(tag + ' NO Mailbox does not exist\r\n'))
          return
        }
        if (folder.flags.includes('\\Noselect')) {
          socket.write(frame(tag + ' NO [CANNOT] Mailbox is not selectable\r\n'))
          return
        }
        selected = path
        const list = listFor(path)
        socket.write(
          frame(
            '* ' + String(list.length) + ' EXISTS\r\n' +
              '* 0 RECENT\r\n' +
              '* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n' +
              '* OK [UIDVALIDITY 1] UIDs valid\r\n' +
              '* OK [UIDNEXT 9000] Predicted next UID\r\n' +
              tag + ' OK [READ-WRITE] SELECT completed\r\n',
          ),
        )
        return
      }
      if (upper.startsWith('UID SEARCH') || upper.startsWith('SEARCH')) {
        const uidMode = upper.startsWith('UID ')
        const rawCriteria = rest.replace(/^UID\s+/i, '').replace(/^SEARCH\s+/i, '')
        const criteria = rawCriteria.toUpperCase()
        let list = listFor(selected)
        if (criteria.includes('UNSEEN')) list = list.filter((entry) => !entry.flags.has('\\Seen'))
        else if (criteria.includes('SEEN')) list = list.filter((entry) => entry.flags.has('\\Seen'))
        if (criteria.includes('FLAGGED')) list = list.filter((entry) => entry.flags.has('\\Flagged'))
        // Enough string-criteria support to prove the server-side path filters.
        const fieldMatch = /(?:^|\s)(FROM|TO|SUBJECT|BODY|TEXT)\s+(?:"([^"]*)"|(\S+))/i.exec(rawCriteria)
        if (fieldMatch !== null && !options.ignoreSearchFilters && !(options.ignoreTextSearch && fieldMatch[1].toUpperCase() === 'TEXT')) {
          const needle = (fieldMatch[2] ?? fieldMatch[3] ?? '').toLowerCase()
          if (needle !== '') {
            list = list.filter((entry) => entry.raw.toString('utf8').toLowerCase().includes(needle))
          }
        }
        const full = listFor(selected)
        const results = list.map((entry) => (uidMode ? entry.uid : full.indexOf(entry) + 1))
        socket.write(
          frame('* SEARCH' + (results.length > 0 ? ' ' + results.join(' ') : '') + '\r\n' + tag + ' OK SEARCH completed\r\n'),
        )
        return
      }
      if (upper.startsWith('UID FETCH') || upper.startsWith('FETCH')) {
        const uidMode = upper.startsWith('UID ')
        const after = rest.replace(/^UID\s+/i, '').replace(/^FETCH\s+/i, '')
        const setEnd = after.indexOf(' ')
        const set = setEnd >= 0 ? after.slice(0, setEnd) : after
        const query = parseFetchQuery(after.slice(setEnd + 1))
        const full = listFor(selected)
        const chunks = []
        for (const uid of resolveSet(set, selected)) {
          const entry = full.find((candidate) => candidate.uid === uid)
          if (entry === undefined) continue
          chunks.push(...fetchResponse(entry, full.indexOf(entry) + 1, query, uidMode))
        }
        socket.write(frame(...chunks, tag + ' OK FETCH completed\r\n'))
        return
      }
      if (upper.startsWith('UID STORE') || upper.startsWith('STORE')) {
        const after = rest.replace(/^UID\s+/i, '').replace(/^STORE\s+/i, '')
        const setEnd = after.indexOf(' ')
        const set = setEnd >= 0 ? after.slice(0, setEnd) : after
        const operation = after.slice(setEnd + 1).trim()
        const add = /\+FLAGS/i.test(operation)
        const remove = /-FLAGS/i.test(operation)
        const flags = (/\(([^)]*)\)/.exec(operation)?.[1] ?? '').split(/\s+/).filter((entry) => entry !== '')
        const uids = resolveSet(set, selected)
        const full = listFor(selected)
        stores.push({ mailbox: selected, uids, add, remove, flags })
        const chunks = []
        for (const uid of uids) {
          const entry = full.find((candidate) => candidate.uid === uid)
          if (entry === undefined) continue
          for (const flag of flags) {
            if (add) entry.flags.add(flag)
            if (remove) entry.flags.delete(flag)
          }
          chunks.push(frame('* ' + String(full.indexOf(entry) + 1) + ' FETCH (UID ' + String(uid) + ' FLAGS (' + [...entry.flags].join(' ') + '))\r\n'))
        }
        socket.write(frame(...chunks, tag + ' OK STORE completed\r\n'))
        return
      }
      if (upper.startsWith('UID COPY') || upper.startsWith('COPY')) {
        const after = rest.replace(/^UID\s+/i, '').replace(/^COPY\s+/i, '')
        const setEnd = after.indexOf(' ')
        const set = setEnd >= 0 ? after.slice(0, setEnd) : after
        const destination = after.slice(setEnd + 1).trim().replace(/^"|"$/g, '')
        copies.push({ from: selected, to: destination, uids: resolveSet(set, selected) })
        socket.write(frame(tag + ' OK COPY completed\r\n'))
        return
      }
      if (upper.startsWith('UID MOVE') || upper.startsWith('MOVE')) {
        const after = rest.replace(/^UID\s+/i, '').replace(/^MOVE\s+/i, '')
        const setEnd = after.indexOf(' ')
        const set = setEnd >= 0 ? after.slice(0, setEnd) : after
        const destination = after.slice(setEnd + 1).trim().replace(/^"|"$/g, '')
        moves.push({ from: selected, to: destination, uids: resolveSet(set, selected) })
        socket.write(frame('* OK moved\r\n' + tag + ' OK MOVE completed\r\n'))
        return
      }
      if (upper.startsWith('EXPUNGE')) {
        socket.write(frame(tag + ' OK EXPUNGE completed\r\n'))
        return
      }
      if (upper.startsWith('CLOSE')) {
        selected = ''
        socket.write(frame(tag + ' OK CLOSE completed\r\n'))
        return
      }
      if (upper.startsWith('UNSELECT')) {
        selected = ''
        socket.write(frame(tag + ' OK UNSELECT completed\r\n'))
        return
      }
      socket.write(frame(tag + ' BAD Unknown command\r\n'))
    }

    /** Accept the bytes of a pending APPEND and answer its tag. */
    const completeAppend = (literal) => {
      const target = listFor(pendingAppend.mailbox)
      appended.push({ mailbox: pendingAppend.mailbox, raw: literal })
      target.push({ uid: 800 + appended.length, raw: literal, flags: new Set(['\\Seen']) })
      const tag = pendingAppend.tag
      pendingAppend = null
      socket.write(frame(tag + ' OK [APPENDUID 1 ' + String(800 + appended.length) + '] APPEND completed\r\n'))
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      // A pending APPEND consumes exactly N raw bytes before the next command.
      if (pendingAppend !== null) {
        if (buffer.length < pendingAppend.size) return
        const literal = buffer.subarray(0, pendingAppend.size)
        buffer = buffer.subarray(pendingAppend.size)
        completeAppend(literal)
      }
      let newlineAt = buffer.indexOf('\r\n')
      while (newlineAt >= 0) {
        const line = buffer.subarray(0, newlineAt).toString('utf8')
        buffer = buffer.subarray(newlineAt + 2)
        // The mailbox may be quoted and contain spaces ("Sent Messages"), so the
        // quoted form has to be tried before the bare-atom form.
        const appendMatch =
          /^(\S+) APPEND\s+"([^"]*)"\s+(?:\([^)]*\)\s+)?\{(\d+)\}$/i.exec(line) ??
          /^(\S+) APPEND\s+(\S+)\s+(?:\([^)]*\)\s+)?\{(\d+)\}$/i.exec(line)
        if (appendMatch !== null) {
          pendingAppend = { tag: appendMatch[1], mailbox: appendMatch[2], size: Number(appendMatch[3]) }
          commands.push(line)
          socket.write(frame('+ Ready for literal data\r\n'))
          return
        }
        handleLine(line)
        newlineAt = buffer.indexOf('\r\n')
      }
    })

    socket.write(frame('* OK [CAPABILITY IMAP4rev1] fake.local ready\r\n'))
  })

  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
  return {
    port,
    appended,
    stores,
    moves,
    copies,
    commands,
    /** True when the server saw a command containing the needle. */
    saw: (needle) => commands.some((line) => line.toUpperCase().includes(needle.toUpperCase())),
    /** Messages currently in a folder (mutations are visible). */
    folder: (path) => listFor(path),
    close: () =>
      new Promise((done) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => done())
      }),
  }
}
