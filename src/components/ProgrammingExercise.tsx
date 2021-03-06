import React, { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import {
  CircularProgress,
  InputLabel,
  Select,
  Snackbar,
  Grid,
} from "@material-ui/core"
import PyEditor from "./PyEditor"
import AnimatedOutputBox, { AnimatedOutputBoxRef } from "./AnimatedOutputBox"
import { v4 as uuid } from "uuid"
import { FileEntry } from "./ProgrammingExerciseLoader"
import {
  PythonImportAll,
  PythonImportSome,
  parseImportAll,
  parseImportSome,
} from "../services/import_parsing"
import { OutputObject, TestResultObject, FeedBackAnswer } from "../types"
import FeedbackForm from "./FeedbackForm"
import styled from "styled-components"
import { OverlayBox, OverlayCenterWrapper } from "./Overlay"
import { remove_fstrings } from "../services/polyfill_python"
import { useWorker } from "../hooks/getWorker"
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome"
import { faExclamationTriangle } from "@fortawesome/free-solid-svg-icons"
import PyEditorButtons from "./PyEditorButtons"
import OutputTitle from "./OutputTitle"
import OutputContent from "./OutputContent"

type ProgrammingExerciseProps = {
  submitFeedback: (
    testResults: TestResultObject,
    feedback: Array<FeedBackAnswer>,
  ) => void
  submitProgrammingExercise: (
    files: Array<FileEntry>,
  ) => Promise<TestResultObject>
  submitToPaste: (files: Array<FileEntry>) => Promise<string>
  initialFiles: Array<FileEntry>
  signedIn: boolean
  editorHeight?: string
  outputHeight?: string
  outputPosition?: string
  ready?: boolean
  solutionUrl?: string
}

const StyledOutput = styled(Grid)`
  padding: 5px;
  display: table-cell;
  min-height: 100px;
  overflow: auto;
  white-space: pre-wrap;
`

const WarningBox = styled(Grid)`
  background-color: #ff9800;
  color: white;
  border-radius: 3px 3px 0 0;
  padding: 8px;
  font-size: 1.25rem;
`

const defaultFile: FileEntry = {
  fullName: "",
  shortName: "",
  originalContent: "",
  content: "",
}

const ProgrammingExercise: React.FunctionComponent<ProgrammingExerciseProps> = ({
  submitFeedback,
  submitProgrammingExercise,
  submitToPaste,
  initialFiles,
  signedIn,
  editorHeight,
  outputHeight,
  outputPosition = "absolute",
  ready = true,
  solutionUrl,
}) => {
  const [t] = useTranslation()
  const [output, setOutput] = useState<OutputObject[]>([])
  const [testResults, setTestResults] = useState<TestResultObject | undefined>()
  const [workerAvailable, setWorkerAvailable] = useState(true)
  const [inputRequested, setInputRequested] = useState(false)
  const [files, setFiles] = useState([defaultFile])
  const [selectedFile, setSelectedFile] = useState(defaultFile)
  const [editorValue, setEditorValue] = useState("")
  const [running, setRunning] = useState(false)
  const [aborted, setAborted] = useState(false)
  const [submitStatus, setSubmitStatus] = useState<{
    submitting: boolean
    paste?: boolean
  }>({ submitting: false })
  const [testing, setTesting] = useState(false)
  const [pasteUrl, setPasteUrl] = useState("")
  const [showFeedbackForm, setShowFeedbackForm] = useState(false)
  const [openNotification, setOpenNotification] = useState(false)
  const [isEditorReady, setIsEditorReady] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [worker] = useWorker()
  const outputBoxRef = React.createRef<AnimatedOutputBoxRef>()

  function handleRun(code?: string) {
    if (workerAvailable) {
      setOutput([])
      setTestResults(undefined)
      setWorkerAvailable(false)
      setShowHelp(false)
      setRunning(true)
      setAborted(false)
      setTesting(false)
      worker.postMessage({
        type: "run",
        msg: remove_fstrings(code ? code : editorValue),
      })
    } else {
      console.log("Worker is busy")
    }
  }

  const handleRunWrapped = () => {
    try {
      const wrapped = wrap(editorValue, [selectedFile.shortName])
      return handleRun(wrapped)
    } catch (error) {
      return handleRun(`print("${error}")`)
    }
  }

  /* Replace import statements of the form "import .mymodule" and
  "from .mymodule import myClass, myFunction" with the contents of
  mymodule.py, appropriately wrapped. Cyclical imports (module foo
  imports from module bar, bar imports from foo) are detected and
  result in an exception. */
  const wrap = (source: string, presentlyImported: Array<string>) => {
    const importAllPattern = /^import \./
    const importSomePattern = /^from \.\w+ import/
    const sourceLines = source.split("\n")
    const lines = sourceLines.map((line, num) => {
      if (line.match(importAllPattern)) {
        return replaceImportAll(parseImportAll(line), num, presentlyImported)
      }
      return line.match(importSomePattern)
        ? replaceImportSome(parseImportSome(line), num, presentlyImported)
        : line
    })
    return lines.join("\n")
  }

  const replaceImportAll = (
    im: PythonImportAll,
    lineNumber: number,
    presentlyImported: Array<string>,
  ): string => {
    const sourceShortName = im.pkg.slice(1) + ".py"
    if (presentlyImported.includes(sourceShortName)) {
      const errMsg =
        sourceShortName +
        " has already been imported. Mutually recursive imports are not allowed."
      throw errMsg
    }
    const source = getContentByShortName(sourceShortName, files)
    const wrapped = wrap(source, presentlyImported.concat([sourceShortName]))
    return `\n${wrapped}\n`
  }

  const replaceImportSome = (
    im: PythonImportSome,
    lineNumber: number,
    presentlyImported: Array<string>,
  ): string => {
    const sourceShortName = im.pkg.slice(1) + ".py"
    if (presentlyImported.includes(sourceShortName)) {
      const errMsg =
        sourceShortName +
        " has already been imported. Mutually recursive imports are not allowed."
      throw errMsg
    }
    const source = getContentByShortName(sourceShortName, files)
    const wrapped = wrap(source, presentlyImported.concat([sourceShortName]))
    const sourceLines = wrapped.split("\n").map((line: string) => "\t" + line)
    const names = im.names.join(", ")
    const functionName = `__wrap${lineNumber}`
    const head = `def ${functionName}():\n`
    const body = sourceLines.join("\n") + "\n"
    const ret = `\treturn ${names}\n`
    const tail = `${names} = ${functionName}()`
    return head + body + ret + tail
  }

  worker.setMessageListener((e: any) => {
    let { type, msg } = e.data
    if (type === "print") {
      setOutput(output.concat({ id: uuid(), type: "output", text: msg }))
    } else if (type === "input_required") {
      setInputRequested(true)
    } else if (type === "error") {
      console.log(msg)
      if (msg.includes("bad token T_OP")) {
        msg =
          msg +
          "\nMake sure you don't use any special characters as variable names, such as å, ä, ö."
      } else if (msg.includes("TypeError: Cannot read property")) {
        msg = msg + "\nMake sure all Python commands use proper syntax."
      }
      setOutput(output.concat({ id: uuid(), type: "error", text: msg }))
      setWorkerAvailable(true)
    } else if (type === "ready") {
      setWorkerAvailable(true)
    } else if (type === "print_batch") {
      if (running) {
        const prints = msg.map((text: string) => ({
          id: uuid(),
          type: "output",
          text,
        }))
        setOutput((prevState) => prevState.concat(prints))
      }
    } else if (type === "print_done") {
      setRunning(false)
    } else if (type === "testResults") {
      console.log("[TEST RESULTS]", msg)
      setRunning(false)
      const results = msg.map((result: any) => ({
        id: uuid(),
        testName: result.testName,
        passed: result.passed,
        feedback: result.feedback || null,
        points: result.points,
      }))
      setTestResults(results)
    }
  })

  const sendInput = (input: string) => {
    if (inputRequested) {
      setInputRequested(false)
      setOutput(
        output.concat({ id: uuid(), type: "input", text: `${input}\n` }),
      )
      worker.postMessage({ type: "input", msg: input })
    }
  }

  const handleChange = (e: any) => {
    setStateForSelectedFile()
    changeFile(e.target.value, files)
  }

  const handleSubmit = (paste: boolean) => {
    setStateForSelectedFile()
    setSubmitStatus({ submitting: true, paste })
  }

  const setStateForSelectedFile = () => {
    setFiles((prev: any) =>
      prev.map((file: any) =>
        file.shortName === selectedFile.shortName
          ? { ...file, content: editorValue }
          : file,
      ),
    )
  }

  const changeFile = (shortName: string, fileList: Array<object>) => {
    setSelectedFile(getFileByShortName(shortName, fileList))
    setEditorValue(getContentByShortName(shortName, fileList))
  }

  const getContentByShortName = (name: string, fileSet: Array<any>) => {
    return getFileByShortName(name, fileSet).content
  }

  const getFileByShortName = (name: string, fileSet: Array<any>) => {
    let firstMatch = fileSet.filter(({ shortName }) => shortName === name)[0]
    return firstMatch
  }

  useEffect(() => {
    setFiles(initialFiles)
    changeFile(initialFiles[0].shortName, initialFiles)
  }, [initialFiles])

  useEffect(() => {
    if (submitStatus.submitting) {
      if (submitStatus.paste) {
        submitToPaste(files).then((res) => setPasteUrl(res))
        setSubmitStatus(() => ({ submitting: false }))
      } else {
        submitProgrammingExercise(files).then((data) => {
          // console.log(data)
          closeOutput()
          setTestResults(data)
          setOutput([])
          setTesting(true)
          setSubmitStatus(() => ({ submitting: false }))
          setShowFeedbackForm(data.allTestsPassed || false)
        })
      }
    }
  }, [submitStatus])

  const stopWorker = () => {
    if (!workerAvailable) {
      worker.terminate()
    }
    worker.postMessage({ type: "stop" })
    setRunning(false)
    setAborted(true)
    setInputRequested(false)
  }

  const closeOutput = () => {
    stopWorker()
    outputBoxRef.current?.close()
    setOutput([])
  }

  const handleCloseNotification = (
    event?: React.SyntheticEvent,
    reason?: string,
  ) => {
    if (reason === "clickaway") {
      return
    }
    setOpenNotification(false)
  }

  /*
  const runTests = () => {
    console.log("Running tests")
    setOutput([])
    setRunning(true)
    setTesting(true)
    worker.postMessage({ type: "runTests" })
  }
  */

  const ieOrEdge =
    window.StyleMedia && window.navigator.userAgent.indexOf("Edge") !== -1

  return (
    <div
      style={{
        position: "relative",
        width: "inherit",
      }}
    >
      {ieOrEdge && (
        <OverlayBox>
          <StyledOutput>
            {t("browserNotSupported")}
            <ul>
              <li>Google Chrome</li>
              <li>Firefox</li>
              <li>Safari</li>
            </ul>
          </StyledOutput>
        </OverlayBox>
      )}
      {showFeedbackForm && (
        <FeedbackForm
          awardedPoints={testResults?.points}
          onSubmitFeedback={(feedback) => {
            setShowFeedbackForm(false)
            if (testResults) {
              submitFeedback(testResults, feedback)
              feedback.length > 0 && setOpenNotification(true)
            }
          }}
          onClose={() => setShowFeedbackForm(false)}
          solutionUrl={testResults?.solutionUrl}
          feedbackQuestions={testResults?.feedbackQuestions}
        />
      )}
      {files.length > 1 && (
        <>
          <InputLabel id="label">{t("selectFile")}</InputLabel>
          <Select
            labelId="label"
            native
            value={selectedFile.shortName}
            onChange={handleChange}
            data-cy="select-file"
          >
            {
              <>
                {files.map(({ shortName }) => (
                  <option key={shortName} value={shortName}>
                    {shortName}
                  </option>
                ))}
              </>
            }
          </Select>
        </>
      )}
      {/* <Button variant="contained" onClick={runTests} data-cy="run-tests-btn">
        Run tests
      </Button> */}
      {!ready && (
        <OverlayCenterWrapper>
          <CircularProgress thickness={5} color="inherit" />
        </OverlayCenterWrapper>
      )}
      <PyEditorButtons
        handleRun={handleRun}
        handleRunWrapped={handleRunWrapped}
        allowRun={workerAvailable}
        handleStop={stopWorker}
        isRunning={running}
        solutionUrl={solutionUrl}
        isEditorReady={isEditorReady}
      />
      {!signedIn && (
        <WarningBox>
          <FontAwesomeIcon icon={faExclamationTriangle} />
          <span style={{ marginLeft: 10 }}>{t("signInToSubmitExercise")}</span>
        </WarningBox>
      )}
      <PyEditor
        editorValue={editorValue}
        setEditorValue={(value) => setEditorValue(value)}
        editorHeight={editorHeight}
        setIsEditorReady={(isReady) => setIsEditorReady(isReady)}
      />
      <AnimatedOutputBox
        isRunning={running}
        outputHeight={outputHeight}
        outputPosition={outputPosition}
        ref={outputBoxRef}
      >
        <Grid container direction="column">
          <OutputTitle
            testResults={testResults}
            inputRequested={inputRequested}
            isRunning={running}
            isAborted={aborted}
            isSubmitting={submitStatus.submitting}
            testing={testing}
            help={false}
            signedIn={signedIn}
            hasErrors={output.some((item: any) => item.type === "error")}
            handleSubmit={() => handleSubmit(false)}
            closeOutput={closeOutput}
            showHelp={() => setShowHelp(true)}
          />
          <OutputContent
            inputRequested={inputRequested}
            outputContent={output}
            help={showHelp}
            handlePasteSubmit={() => handleSubmit(true)}
            pasteUrl={pasteUrl}
            sendInput={sendInput}
            testResults={testResults}
            outputHeight={outputHeight}
          />
        </Grid>
      </AnimatedOutputBox>
      <Snackbar
        open={openNotification}
        autoHideDuration={5000}
        onClose={handleCloseNotification}
        message={t("thankYouForFeedback")}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        key="bottom-center"
      />
    </div>
  )
}

const defaultSrcContent = `# No ProgrammingExercise has been loaded.
# This is the default file main.py

from .utils import greeting, getLocality

def greetWorld():
  print(greeting(getLocality()))

def foo():
  print("foo!")
`

const defaultTestContent = `# No ProgrammingExercise has been loaded.
# This is the default file test.py

from .main import greetWorld

greetWorld()
`

const defaultUtilsContent = `# No ProgrammingExercise has been loaded.
# This is the default file utils.py

# Mutually recursive imports are disallowed.
# Try uncommenting the line below!
#from .main import foo

def greeting(recipient):
  return "Hello " + recipient + "!"

def getLocality():
  return "world"
`

ProgrammingExercise.defaultProps = {
  submitProgrammingExercise: () =>
    Promise.resolve({ points: [], testCases: [] }),
  submitToPaste: () => Promise.resolve("default paste called"),
  initialFiles: [
    {
      fullName: "main.py",
      shortName: "main.py",
      originalContent: defaultSrcContent,
      content: defaultSrcContent,
    },
    {
      fullName: "utils.py",
      shortName: "utils.py",
      originalContent: defaultUtilsContent,
      content: defaultUtilsContent,
    },
    {
      fullName: "test.py",
      shortName: "test.py",
      originalContent: defaultTestContent,
      content: defaultTestContent,
    },
  ],
}

export { ProgrammingExercise, ProgrammingExerciseProps, defaultFile }
