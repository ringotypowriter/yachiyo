import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'

const rootDir = process.cwd()

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'yachiyo-core-skill-'))
}

async function runJsonScript(scriptPath: string, inputPath: string): Promise<unknown> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn('python3', [scriptPath, inputPath, '--json'], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`script failed (${code}): ${stderr || stdout}`))
        return
      }
      resolveOutput(stdout)
    })
  })

  return JSON.parse(output)
}

async function runCommandJson(scriptPath: string, args: string[]): Promise<unknown> {
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn('python3', [scriptPath, ...args], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`script failed (${code}): ${stderr || stdout}`))
        return
      }
      resolveOutput(stdout)
    })
  })

  return JSON.parse(output)
}

async function writeZip(
  path: string,
  entries: Array<{ name: string; content: string }>
): Promise<void> {
  const archivePath = join(tmpdir(), `zip-${Math.random().toString(36).slice(2)}.py`)
  const payload = JSON.stringify(entries)
  const program = [
    'import json, sys, zipfile',
    'entries = json.loads(sys.argv[2])',
    'with zipfile.ZipFile(sys.argv[1], "w") as archive:',
    '    for entry in entries:',
    '        archive.writestr(entry["name"], entry["content"])'
  ].join('\n')
  await writeFile(archivePath, program)
  await new Promise<void>((resolveDone, reject) => {
    const child = spawn('python3', [archivePath, path, payload], {
      cwd: rootDir,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`zip writer failed (${code}): ${stderr}`))
        return
      }
      resolveDone()
    })
  })
  await rm(archivePath, { force: true })
}

test('docx inspector reports placeholders and structure', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'sample.docx')
    await writeZip(path, [
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      },
      {
        name: 'word/document.xml',
        content:
          '<?xml version="1.0"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body>' +
          '<w:p><w:r><w:t>Hello {{leader}}</w:t></w:r></w:p>' +
          '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
          '<w:p><w:ins><w:r><w:t>Tracked</w:t></w:r></w:ins></w:p>' +
          '</w:body></w:document>'
      },
      {
        name: 'word/comments.xml',
        content:
          '<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0"/></w:comments>'
      },
      {
        name: 'word/header1.xml',
        content:
          '<?xml version="1.0"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'
      },
      { name: 'word/media/image1.png', content: 'fake' }
    ])

    const report = (await runJsonScript(
      resolve(rootDir, 'resources/core-skills/yachiyo-docx/scripts/docx_inspect.py'),
      path
    )) as {
      paragraph_count: number
      table_count: number
      image_count: number
      comment_count: number
      track_change_count: number
      placeholder_tokens: string[]
    }

    assert.equal(report.paragraph_count, 3)
    assert.equal(report.table_count, 1)
    assert.equal(report.image_count, 1)
    assert.equal(report.comment_count, 1)
    assert.equal(report.track_change_count, 1)
    assert.deepEqual(report.placeholder_tokens, ['{{leader}}'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('xlsx inspector reports sheets formulas and workbook features', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'sample.xlsx')
    await writeZip(path, [
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      },
      {
        name: 'xl/workbook.xml',
        content:
          '<?xml version="1.0"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<sheets><sheet name="Summary" sheetId="1"/><sheet name="Data" sheetId="2"/></sheets>' +
          '<definedNames><definedName name="MyRange">Summary!$A$1</definedName></definedNames>' +
          '</workbook>'
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<?xml version="1.0"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<dimension ref="A1:B2"/><sheetData><row r="1"/><row r="2"/></sheetData>' +
          '<sheetData/><mergeCells><mergeCell ref="A1:B1"/></mergeCells>' +
          '<dataValidations><dataValidation sqref="A2"/></dataValidations>' +
          '<tableParts count="1"><tablePart r:id="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></tableParts>' +
          '<sheetData><row r="1"><c r="B2"><f>SUM(A1:A1)</f></c></row></sheetData>' +
          '</worksheet>'
      },
      {
        name: 'xl/worksheets/sheet2.xml',
        content:
          '<?xml version="1.0"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<dimension ref="A1:A3"/><sheetData><row r="1"/><row r="2"/><row r="3"/></sheetData>' +
          '</worksheet>'
      },
      {
        name: 'xl/tables/table1.xml',
        content: '<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'
      },
      {
        name: 'xl/charts/chart1.xml',
        content: '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>'
      },
      {
        name: 'xl/drawings/drawing1.xml',
        content:
          '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>'
      },
      {
        name: 'xl/externalLinks/externalLink1.xml',
        content: '<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'
      },
      { name: 'xl/vbaProject.bin', content: 'fake' },
      {
        name: 'xl/calcChain.xml',
        content: '<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>'
      }
    ])

    const report = (await runJsonScript(
      resolve(rootDir, 'resources/core-skills/yachiyo-xlsx/scripts/xlsx_inspect.py'),
      path
    )) as {
      sheet_count: number
      table_count: number
      chart_count: number
      external_link_count: number
      has_macros: boolean
      sheets: Array<{ name: string; formula_count: number }>
    }

    assert.equal(report.sheet_count, 2)
    assert.equal(report.table_count, 1)
    assert.equal(report.chart_count, 1)
    assert.equal(report.external_link_count, 1)
    assert.equal(report.has_macros, true)
    assert.equal(report.sheets[0]?.name, 'Summary')
    assert.equal(report.sheets[0]?.formula_count, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pptx inspector reports slide text and notes presence', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'sample.pptx')
    await writeZip(path, [
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      },
      {
        name: 'ppt/presentation.xml',
        content:
          '<?xml version="1.0"?>' +
          '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
          '<p:sldIdLst><p:sldId id="256"/><p:sldId id="257"/></p:sldIdLst>' +
          '</p:presentation>'
      },
      {
        name: 'ppt/slides/slide1.xml',
        content:
          '<?xml version="1.0"?>' +
          '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
          '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Title Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>' +
          '</p:sld>'
      },
      {
        name: 'ppt/slides/slide2.xml',
        content:
          '<?xml version="1.0"?>' +
          '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
          '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second Slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>' +
          '</p:sld>'
      },
      {
        name: 'ppt/notesSlides/notesSlide1.xml',
        content: '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'
      },
      { name: 'ppt/media/image1.png', content: 'fake' },
      {
        name: 'ppt/charts/chart1.xml',
        content: '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>'
      }
    ])

    const report = (await runJsonScript(
      resolve(rootDir, 'resources/core-skills/yachiyo-pptx/scripts/pptx_inspect.py'),
      path
    )) as {
      slide_count: number
      notes_slide_count: number
      image_count: number
      chart_count: number
      slides: Array<{ title: string }>
    }

    assert.equal(report.slide_count, 2)
    assert.equal(report.notes_slide_count, 1)
    assert.equal(report.image_count, 1)
    assert.equal(report.chart_count, 1)
    assert.equal(report.slides[0]?.title, 'Title Slide')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pdf inspector reports basic PDF facts', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'sample.pdf')
    const lines = [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj',
      'trailer << /Root 1 0 R >>',
      '%%EOF'
    ]
    await writeFile(path, lines.join('\n'))

    const report = (await runJsonScript(
      resolve(rootDir, 'resources/core-skills/yachiyo-pdf/scripts/pdf_inspect.py'),
      path
    )) as {
      exists: boolean
      is_pdf_header: boolean
      page_count: number | null
      recommended_actions: string[]
    }

    assert.equal(report.exists, true)
    assert.equal(report.is_pdf_header, true)
    assert.equal(report.page_count, 1)
    assert.ok(report.recommended_actions.length >= 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pdf field lister finds simple AcroForm names', async () => {
  const dir = await makeTempDir()
  try {
    const path = join(dir, 'form.pdf')
    const lines = [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /AcroForm 2 0 R >> endobj',
      '2 0 obj << /Fields [3 0 R 4 0 R] >> endobj',
      '3 0 obj << /T (full_name) /FT /Tx >> endobj',
      '4 0 obj << /T (accept_terms) /FT /Btn >> endobj',
      '%%EOF'
    ]
    await writeFile(path, lines.join('\n'))

    const report = (await runJsonScript(
      resolve(rootDir, 'resources/core-skills/yachiyo-pdf/scripts/pdf_list_form_fields.py'),
      path
    )) as {
      has_acroform_marker: boolean
      field_count: number
      field_names: string[]
      field_types: string[]
    }

    assert.equal(report.has_acroform_marker, true)
    assert.equal(report.field_count, 2)
    assert.deepEqual(report.field_names, ['accept_terms', 'full_name'])
    assert.deepEqual(report.field_types, ['Btn', 'Tx'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('docx fill template replaces placeholder text in copied output', async () => {
  const dir = await makeTempDir()
  try {
    const inputPath = join(dir, 'template.docx')
    const outputPath = join(dir, 'filled.docx')
    const mapPath = join(dir, 'values.json')
    await writeZip(inputPath, [
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      },
      {
        name: 'word/document.xml',
        content:
          '<?xml version="1.0"?>' +
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          '<w:body><w:p><w:r><w:t>Hello {{leader}}</w:t></w:r></w:p></w:body></w:document>'
      }
    ])
    await writeFile(mapPath, JSON.stringify({ '{{leader}}': 'Ringo' }))

    const report = (await runCommandJson(
      resolve(rootDir, 'resources/core-skills/yachiyo-docx/scripts/docx_fill_template.py'),
      [inputPath, outputPath, '--map', mapPath]
    )) as {
      replaced_text_nodes: number
    }

    assert.equal(report.replaced_text_nodes, 1)

    const inspect = (await runJsonScript(
      resolve(rootDir, 'resources/core-skills/yachiyo-docx/scripts/docx_inspect.py'),
      outputPath
    )) as {
      sample_text: string[]
      placeholder_tokens: string[]
    }

    assert.equal(inspect.sample_text[0], 'Hello Ringo')
    assert.deepEqual(inspect.placeholder_tokens, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('xlsx export sheet csv writes selected sheet content', async () => {
  const dir = await makeTempDir()
  try {
    const inputPath = join(dir, 'book.xlsx')
    const outputPath = join(dir, 'summary.csv')
    await writeZip(inputPath, [
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      },
      {
        name: 'xl/workbook.xml',
        content:
          '<?xml version="1.0"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets>' +
          '</workbook>'
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        content:
          '<?xml version="1.0"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>' +
          '</Relationships>'
      },
      {
        name: 'xl/sharedStrings.xml',
        content:
          '<?xml version="1.0"?>' +
          '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<si><t>Name</t></si><si><t>Value</t></si><si><t>Revenue</t></si>' +
          '</sst>'
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        content:
          '<?xml version="1.0"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          '<sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1200</v></c></row>' +
          '</sheetData>' +
          '</worksheet>'
      }
    ])

    const report = (await runCommandJson(
      resolve(rootDir, 'resources/core-skills/yachiyo-xlsx/scripts/xlsx_export_sheet_csv.py'),
      [inputPath, outputPath, '--sheet', 'Summary']
    )) as {
      sheet_name: string
      row_count: number
    }

    assert.equal(report.sheet_name, 'Summary')
    assert.equal(report.row_count, 2)

    const csvText = await (await import('node:fs/promises')).readFile(outputPath, 'utf8')
    assert.equal(csvText.replaceAll('\r\n', '\n').trim(), 'Name,Value\nRevenue,1200')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pptx replace text updates target slide content', async () => {
  const dir = await makeTempDir()
  try {
    const inputPath = join(dir, 'deck.pptx')
    const outputPath = join(dir, 'deck-updated.pptx')
    await writeZip(inputPath, [
      {
        name: '[Content_Types].xml',
        content:
          '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
      },
      {
        name: 'ppt/presentation.xml',
        content:
          '<?xml version="1.0"?>' +
          '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
          '<p:sldIdLst><p:sldId id="256"/></p:sldIdLst>' +
          '</p:presentation>'
      },
      {
        name: 'ppt/slides/slide1.xml',
        content:
          '<?xml version="1.0"?>' +
          '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
          '<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Old title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld>' +
          '</p:sld>'
      }
    ])

    const report = (await runCommandJson(
      resolve(rootDir, 'resources/core-skills/yachiyo-pptx/scripts/pptx_replace_text.py'),
      [inputPath, outputPath, '--from', 'Old title', '--to', 'New title']
    )) as {
      replaced_text_nodes: number
    }

    assert.equal(report.replaced_text_nodes, 1)

    const inspect = (await runJsonScript(
      resolve(rootDir, 'resources/core-skills/yachiyo-pptx/scripts/pptx_inspect.py'),
      outputPath
    )) as {
      slides: Array<{ title: string }>
    }

    assert.equal(inspect.slides[0]?.title, 'New title')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
