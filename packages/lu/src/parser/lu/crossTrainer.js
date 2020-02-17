/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

const helpers = require('../utils/helpers')
const luParser = require('../lufile/luParser')
const SectionOperator = require('../lufile/sectionOperator')
const LUSectionTypes = require('../utils/enums/lusectiontypes')
const LUResource = require('../lufile/luResource')
const DiagnosticSeverity = require('../lufile/diagnostic').DiagnosticSeverity
const fileHelper = require('../../utils/filehelper')
const NEWLINE = require('os').EOL
const path = require('path')

module.exports = {
  /**
   * Do cross training among lu files
   * @param {luObject[]} luObjectArray the lu object list to be parsed
   * @param {luObject[]} qnaObjectArray the qna Object list to be parsed
   * @param {any} crossTrainConfig cross train json config
   * @returns {Map<string, LUResource>} map of file id and luResource
   * @throws {exception} throws errors
   */
  crossTrain: function (luObjectArray, qnaObjectArray, crossTrainConfig) {
    try {
      const crossTrainConfigObj = JSON.parse(crossTrainConfig)
      const rootObjectIds = crossTrainConfigObj.rootIds.map(x => path.resolve(x))
      const triggerRules = crossTrainConfigObj.triggerRules
      const intentName = crossTrainConfigObj.intentName
      const verbose = crossTrainConfigObj.verbose

      // parse lu content to LUResource object
      let luFileIdToResourceMap = parseAndValidateContent(luObjectArray, verbose)

      // parse qna content to LUResource object
      let qnaFileIdToResourceMap = parseAndValidateContent(qnaObjectArray, verbose)

      // construct resource tree to build the father-children relationship among lu files
      let resources = constructResoureTree(luFileIdToResourceMap, triggerRules)

      // do lu cross training from roots. One root one core training
      for (const rootObjectId of rootObjectIds) {
        if (resources.some(r => r.id === rootObjectId)) {
          // do cross training for each root at top level
          const result = luCrossTrain(rootObjectId, resources, qnaFileIdToResourceMap, intentName)
          for (const res of result) {
            luFileIdToResourceMap.set(res.id, res.content)
          }
        } else {
          throw new Error(`Sorry, root lu file '${rootObjectId}' does not exist`)
        }
      }

      // do qna cross training with lu files
      qnaCrossTrain(qnaFileIdToResourceMap, luFileIdToResourceMap)

      return { luResult: luFileIdToResourceMap, qnaResult: qnaFileIdToResourceMap }
    } catch (err) {
      throw (err)
    }
  }
}

/**
 * Contruct resource tree to build the father-children relationship among lu files
 * @param {Map<string, LUResource>} fileIdToLuResourceMap Map of file id and luResource
 * @param {any} triggerRules trigger rules object that indicate the triggering rules from root to dest lu files
 * @returns {any[]} object array of LUResource with id and children properties 
 * @throws {exception} throws errors
 */
const constructResoureTree = function (fileIdToLuResourceMap, triggerRules) {
  let visitedChildren = new Set()
  let resources = []
  let fileIdsFromInput = Array.from(fileIdToLuResourceMap.keys())
  for (const fileId of fileIdsFromInput) {
    let luResource = fileIdToLuResourceMap.get(fileId)
    let resource = {
      id: fileId,
      content: luResource,
      children: []
    }

    if (!(fileId in triggerRules)) {
      resources.push(resource)
      continue
    }

    let intents = []
    for (const section of luResource.Sections) {
      if (section.SectionType === LUSectionTypes.SIMPLEINTENTSECTION
        || section.SectionType === LUSectionTypes.NESTEDINTENTSECTION) {
        intents.push(section)
      }
    }

    const destLuFileToIntent = triggerRules[fileId]
    for (const destLuFile of Object.keys(destLuFileToIntent)) {
      if (!fileIdsFromInput.includes(destLuFile)) continue

      if (visitedChildren.has(destLuFile)) {
        // validate loop in a tree or forest
        throw new Error(`Sorry, dialog call loop detected for lu file ${destLuFile} when doing cross training`)
      }

      const triggerIntentName = destLuFileToIntent[destLuFile]
      if (!intents.some(i => i.Name === triggerIntentName)) {
        throw new Error(`Sorry, trigger intent '${triggerIntentName}' is not found in lu file: ${fileId}`)
      }

      resource.children.push({
        target: destLuFile,
        intent: triggerIntentName
      })

      visitedChildren.add(destLuFile)
    }

    resources.push(resource)
  }

  return resources
}

/**
 * Lu cross training core function. Do lu cross training from a root to its children once.
 * @param {string} rootResourceId the root resource object id
 * @param {any[]} resources all lu resource object list
 * @param {any[]} qnaFileToResourceMap map of qna file id and resource
 * @param {string} intentName interuption intent name
 * @returns {any[]} updated resource objects
 */
const luCrossTrain = function (rootResourceId, resources, qnaFileToResourceMap, intentName) {
  const idToResourceMap = new Map()
  for (const resource of resources) {
    idToResourceMap.set(resource.id, resource)
  }

  // Parse resources
  let rootResource = resources.filter(r => r.id === rootResourceId)[0]
  rootResource.visited = true
  mergeRootInteruptionToLeaves(rootResource, idToResourceMap, qnaFileToResourceMap, intentName)

  return Array.from(idToResourceMap.values())
}

const mergeRootInteruptionToLeaves = function (rootResource, result, qnaFileToResourceMap, intentName) {
  if (rootResource.children === undefined || rootResource.length <= 0) return

  mergeBrothersInteruption(rootResource, result, intentName)
  for (const child of rootResource.children) {
    let childResource = result.get(child.target)
    if (childResource.visited === undefined) {
      const rootQnaFileId = path.join(path.dirname(rootResource.id), path.basename(rootResource.id, helpers.FileExtTypeEnum.LUFile).concat(helpers.FileExtTypeEnum.QnAFile))
      const rootQnaResource = qnaFileToResourceMap.get(rootQnaFileId)
      const newChildResource = mergeFatherInteruptionToChild(rootResource, rootQnaResource, childResource, intentName)
      result.set(child.target, newChildResource)
      newChildResource.visited = true
      mergeRootInteruptionToLeaves(newChildResource, result, qnaFileToResourceMap, intentName)
    }
  }
}

const mergeBrothersInteruption = function (resource, result, intentName) {
  let children = resource.children
  for (const child of children) {
    let triggerIntent = child.intent
    const brotherSections = resource.content.Sections.filter(s => s.Name !== triggerIntent
      && s.Name !== intentName
      && (s.SectionType === LUSectionTypes.SIMPLEINTENTSECTION || s.SectionType === LUSectionTypes.NESTEDINTENTSECTION))

    let brotherUtterances = []
    brotherSections.forEach(s => {
      if (s.SectionType === LUSectionTypes.SIMPLEINTENTSECTION) {
        brotherUtterances = brotherUtterances.concat(s.UtteranceAndEntitiesMap.map(u => u.utterance))
      } else {
        s.SimpleIntentSections.forEach(section => {
          brotherUtterances = brotherUtterances.concat(section.UtteranceAndEntitiesMap.map(u => u.utterance))
        })
      }
    })

    let targetResource = result.get(child.target)

    // Merge direct brother's utterances
    targetResource = mergeInteruptionIntent(brotherUtterances, targetResource, intentName)
    result.set(targetResource.id, targetResource)
  }
}

const mergeFatherInteruptionToChild = function (fatherResource, fatherQnaResource, childResource, intentName) {
  let fatherUtterances = []

  // extract father existing interuption utterances
  const fatherInteruptions = fatherResource.content.Sections.filter(s => s.Name === intentName)
  if (fatherInteruptions && fatherInteruptions.length > 0) {
    const fatherInteruption = fatherInteruptions[0]
    fatherUtterances = fatherUtterances.concat(fatherInteruption.UtteranceAndEntitiesMap.map(u => u.utterance))
  }

  // extract corresponding qna questions from father
  let questions = []
  if (fatherQnaResource) {
    const qnaSections = fatherQnaResource.Sections.filter(s => s.SectionType === LUSectionTypes.QNASECTION)
    qnaSections.forEach(q => questions = questions.concat(q.Questions))
  }

  fatherUtterances = fatherUtterances.concat(questions)
  if (fatherUtterances.length > 0) {
    childResource = mergeInteruptionIntent(fatherUtterances, childResource, intentName)
  }

  return childResource
}

const mergeInteruptionIntent = function (fromUtterances, toResource, intentName) {
  // remove duplicated utterances in fromUtterances
  const dedupFromUtterances = Array.from(new Set(fromUtterances))
  let existingUtterances = extractIntentUtterances(toResource.content)
  const toInteruptions = toResource.content.Sections.filter(section => section.Name === intentName)
  if (toInteruptions && toInteruptions.length > 0) {
    const toInteruption = toInteruptions[0]
    // construct new content here
    let newFileContent = ''
    dedupFromUtterances.forEach(utterance => {
      if (!existingUtterances.includes(utterance)) {
        newFileContent += '- ' + utterance + NEWLINE
      }
    })

    if (newFileContent === '') return toResource

    const existingContent = `# ${toInteruption.Name}${NEWLINE}${toInteruption.Body}`
    newFileContent = existingContent + NEWLINE + newFileContent
    let lines = newFileContent.split(/\r?\n/)
    let newLines = []
    lines.forEach(line => {
      if (line.trim().startsWith('-')) {
        newLines.push('- ' + line.trim().slice(1).trim())
      } else if (line.trim().startsWith('##')) {
        newLines.push('## ' + line.trim().slice(2).trim())
      } else if (line.trim().startsWith('#')) {
        newLines.push('# ' + line.trim().slice(1).trim())
      }
    })

    newFileContent = newLines.join(NEWLINE)

    // update section here
    toResource.content = new SectionOperator(toResource.content).updateSection(toInteruption.Id, newFileContent)
  } else {
    // construct new content here
    const dedupUtterances = dedupFromUtterances.filter(u => !existingUtterances.includes(u))
    if (dedupUtterances && dedupUtterances.length > 0) {
      let newFileContent = `# ${intentName}${NEWLINE}- `
      newFileContent += dedupUtterances.join(`${NEWLINE}- `)

      // add section here
      // not add the interuption intent if original file is empty
      if (toResource.content.Content !== '') {
        toResource.content = new SectionOperator(toResource.content).addSection(newFileContent)
      }
    }
  }

  return toResource
}

const extractIntentUtterances = function(resource, intentName) {
  const intentSections = resource.Sections.filter(s => s.SectionType === LUSectionTypes.SIMPLEINTENTSECTION || s.SectionType === LUSectionTypes.NESTEDINTENTSECTION)

  let intentUtterances = []
  if (intentName && intentName !== '') {
    const specificSections = intentSections.filter(s => s.Name === intentName)
    if (specificSections.length > 0) {
      intentUtterances = intentUtterances.concat(specificSections[0].UtteranceAndEntitiesMap.map(u => u.utterance))
    }
  } else {
    intentSections.forEach(s => {
      if (s.SectionType === LUSectionTypes.SIMPLEINTENTSECTION) {
        intentUtterances = intentUtterances.concat(s.UtteranceAndEntitiesMap.map(u => u.utterance))
      } else {
        s.SimpleIntentSections.forEach(section => {
          intentUtterances = intentUtterances.concat(section.UtteranceAndEntitiesMap.map(u => u.utterance))
        })
      }
  })}

  return intentUtterances
}

/**
 * do qna cross training with lu files
 * @param {Map<string, LUResource>} qnaFileIdToResourceMap map of qna file id and resource
 * @param {Map<string, LUResource>} luFileIdToResourceMap map of lu file id and resource
 * @throws {exception} throws errors
 */
const qnaCrossTrain = function (qnaFileIdToResourceMap, luFileIdToResourceMap) {
  try {
    for (const luObjectId of Array.from(luFileIdToResourceMap.keys())) {
      const qnaObjectId = path.join(path.dirname(luObjectId), path.basename(luObjectId, helpers.FileExtTypeEnum.LUFile).concat(helpers.FileExtTypeEnum.QnAFile))
      let fileName = path.basename(luObjectId, path.extname(luObjectId))
      const culture = fileHelper.getCultureFromPath(luObjectId)
      fileName = culture ? fileName.substring(0, fileName.length - culture.length - 1) : fileName

      if (Array.from(qnaFileIdToResourceMap.keys()).some(q => q === qnaObjectId)) {
        const { luResource, qnaResource } = qnaCrossTrainCore(luFileIdToResourceMap.get(luObjectId), qnaFileIdToResourceMap.get(qnaObjectId), fileName)
        luFileIdToResourceMap.set(luObjectId, luResource)
        qnaFileIdToResourceMap.set(qnaObjectId, qnaResource)
      }
    }
  } catch (err) {
    throw (err)
  }
}

/**
 * qna cross training core function
 * @param {LUResource} luResource the lu resource
 * @param {LUResource} qnaResource the qna resource
 * @param {string} fileName file name
 * @param {string} interruptionIntentName interruption intent name
 * @returns {luResource: LUResource, qnaResource: LUResource} cross trained lu resource and qna resource
 */
const qnaCrossTrainCore = function (luResource, qnaResource, fileName, interruptionIntentName) {
  let trainedLuResource = luResource
  let trainedQnaResource = qnaResource

  // extract questions
  const qnaSections = qnaResource.Sections.filter(s => s.SectionType === LUSectionTypes.QNASECTION)
  let questions = []
  qnaSections.forEach(q => questions = questions.concat(q.Questions))
  
  // remove dups of questions themselves
  questions = Array.from(new Set(questions))

  // extract lu utterances of all intents
  let utterances = extractIntentUtterances(luResource)
  utterances = Array.from(new Set(utterances))

  // extract lu utterances of interruption intent
  let utterancesOfInterruption = extractIntentUtterances(luResource, interruptionIntentName)

  // extract lu utterances except interruption
  let utterancesOfLocalIntents = utterances.filter(u => !utterancesOfInterruption.includes(u))

  // remove questions which are duplicated with local lu utterances
  let dedupedQuestions = questions.filter(q => !utterancesOfLocalIntents.includes(q))

  // update interruption intent if there are duplications with questions
  if (utterancesOfInterruption.some(u => dedupedQuestions.includes(u))) {
    utterancesOfInterruption = utterancesOfInterruption.filter(u => !dedupedQuestions.includes(u))

    // get section id
    const sectionId = trainedLuResource.Sections.filter(s => s.Name === interruptionIntentName)[0].Id

    // construct updated interruption intent content
    utterancesOfInterruption = utterancesOfInterruption.map(u => '- '.concat(u))
    let updatedSectionContent = utterancesOfInterruption.join(NEWLINE)
    if (updatedSectionContent && updatedSectionContent !== '') {
      trainedLuResource = new SectionOperator(trainedLuResource).updateSection(sectionId, `# ${interruptionIntentName}${NEWLINE}${updatedSectionContent}`)
    }
  }

  // construct questions content
  dedupedQuestions = dedupedQuestions.map(q => '- '.concat(q))
  let questionsContent = dedupedQuestions.join(NEWLINE)

  // add questions from qna file to corresponding lu file with intent named DeferToRecognizer_QnA_${fileName}
  if (questionsContent && questionsContent !== '') {
    const questionsToUtterances = `# DeferToRecognizer_QnA_${fileName}${NEWLINE}${questionsContent}`
    trainedLuResource = new SectionOperator(luResource).addSection(questionsToUtterances)
  }

  // update qna filters
  let qnaSectionContents = []
  for (const qnaSection of qnaSections) {
    qnaSection.FilterPairs.push({ key: 'dialogName', value: fileName })
    const qnaSectionContent = `# ?${qnaSection.Questions.join(NEWLINE + '- ')}${NEWLINE}${NEWLINE}**Filters:**${NEWLINE}- ${qnaSection.FilterPairs.map(f => f.key + '=' + f.value).join(NEWLINE + '- ')}${NEWLINE}${NEWLINE}\`\`\`${NEWLINE}${qnaSection.Answer}${NEWLINE}\`\`\``
    qnaSectionContents.push(qnaSectionContent)
  }

  const qnaContents = qnaSectionContents.join(NEWLINE + NEWLINE)
  if (qnaContents && qnaContents !== '') {
    trainedQnaResource = new SectionOperator(new LUResource([], '', [])).addSection(qnaContents)
  }

  // remove utterances which are duplicated with local qna questions
  const dedupedUtterances = utterances.filter(u => !questions.includes(utterances))

  // construct new question content for qna resource
  let utterancesContent = dedupedUtterances.join(NEWLINE + '- ')

  // add utterances from lu file to corresponding qna file with question set to all utterances
  if (utterancesContent && utterancesContent !== '' && qnaSections.length > 0) {
    const utterancesToQuestion = `> Source:cross training. Please do not edit these directly!${NEWLINE}# ?${utterancesContent}${NEWLINE}${NEWLINE}**Filters:**${NEWLINE}- dialogName=${fileName}${NEWLINE}${NEWLINE}\`\`\`${NEWLINE}intent=DeferToRecognizer_LUIS_${fileName}${NEWLINE}\`\`\``
    trainedQnaResource = new SectionOperator(trainedQnaResource).addSection(utterancesToQuestion)
  }

  return { luResource: trainedLuResource, qnaResource: trainedQnaResource }
}

/**
 * Parse and validate lu or qna object array to convert to LUResource object dict
 * @param {luObject[]} objectArray the lu or qna object list to be parsed
 * @param {boolean} verbose indicate to enable log messages or not
 * @returns {Map<string, LUResource>} map of file id and luResource
 * @throws {exception} throws errors
 */
const parseAndValidateContent = function (objectArray, verbose) {
  let fileIdToResourceMap = new Map()
  for (const object of objectArray) {
    let content = object.content
    content = helpers.sanitizeNewLines(content)
    let resource = luParser.parse(content)
    if (resource.Errors && resource.Errors.length > 0) {
      if (verbose) {
        var warns = resource.Errors.filter(error => (error && error.Severity && error.Severity === DiagnosticSeverity.WARN))
        if (warns.length > 0) {
          process.stdout.write(warns.map(warn => warn.toString()).join(NEWLINE).concat(NEWLINE))
        }
      }

      var errors = resource.Errors.filter(error => (error && error.Severity && error.Severity === DiagnosticSeverity.ERROR))
      if (errors.length > 0) {
        throw new Error(errors.map(error => error.toString()).join(NEWLINE))
      }
    }

    fileIdToResourceMap.set(object.id, resource)
  }

  return fileIdToResourceMap
}