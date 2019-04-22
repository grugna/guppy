import { esFieldNumericTextTypeMapping, NumericTextTypeTypeEnum, SCROLL_PAGE_SIZE } from './const';

const getNumericTextType = (
  esInstance,
  esIndex,
  esType,
  field,
) => {
  if (!esInstance.fieldTypes[esIndex] || !esInstance.fieldTypes[esIndex][field]) {
    throw new Error(`Invalid index (${esIndex}) or field name ${field}, 
    please check your query is valid, or typo in manifest file`);
  }
  const numericTextType = esFieldNumericTextTypeMapping[esInstance.fieldTypes[esIndex][field]];
  if (typeof numericTextType === 'undefined') {
    throw new Error(`ES type ${esInstance.fieldTypes[esIndex][field]} not supported yet`);
  }
  return numericTextType;
};

// FIXME: support "is not"
const getFilterItemForString = (op, field, value) => {
  switch (op) {
    case '=':
    case 'eq':
    case 'EQ':
      return {
        term: {
          [field]: value,
        },
      };
    case 'in':
    case 'IN':
      return {
        terms: {
          [field]: value,
        },
      };
    default:
      throw new Error(`Invalid text filter operation "${op}"`);
  }
};

const getFilterItemForNumbers = (op, field, value) => {
  const rangeOperator = {
    '>': 'gt',
    gt: 'gt',
    GT: 'gt',
    '>=': 'gte',
    gte: 'gte',
    GTE: 'gte',
    '<': 'lt',
    lt: 'lt',
    LT: 'lt',
    '<=': 'lte',
    lte: 'lte',
    LTE: 'lte',
  };
  if (op in rangeOperator) {
    return {
      range: {
        [field]: { [rangeOperator[op]]: value },
      },
    };
  }
  if (op === '=') {
    return {
      term: {
        [field]: value,
      },
    };
  }
  if (op === 'IN' || op === 'in') {
    return {
      terms: {
        [field]: value,
      },
    };
  }
  throw new Error(`Invalid numeric operation "${op}" for field "${field}"`);
};

/**
 * This function transfer graphql filter arg to ES filter object
 * It first parse graphql filter object recursively from top to down,
 * until reach the bottom level, it translate gql filter unit to ES filter unit.
 * And finally combines all filter units from down to top.
 * @param {string} esInstance
 * @param {string} esIndex
 * @param {string} esType
 * @param {object} graphqlFilterObj
 * @param {string[]} aggsField - target agg field, only need for agg queries
 * @param {boolean} filterSelf - whether we want to filter this field or not,
 *                               only need for agg queries
 */
export const getFilterObj = (
  esInstance, esIndex, esType, graphqlFilterObj, aggsField, filterSelf = true,
) => {
  const topLevelOp = Object.keys(graphqlFilterObj)[0];
  if (typeof topLevelOp === 'undefined') return null;
  let resultFilterObj = {};
  if (topLevelOp === 'AND' || topLevelOp === 'OR') {
    const boolConnectOp = topLevelOp === 'AND' ? 'must' : 'should';
    const boolItemsList = [];
    graphqlFilterObj[topLevelOp].forEach((filterItem) => {
      const filterObj = getFilterObj(
        esInstance, esIndex, esType, filterItem, aggsField, filterSelf,
      );
      if (filterObj) {
        boolItemsList.push(filterObj);
      }
    });
    if (boolItemsList.length === 0) {
      resultFilterObj = null;
    } else {
      resultFilterObj = {
        bool: {
          [boolConnectOp]: boolItemsList,
        },
      };
    }
  } else {
    const field = Object.keys(graphqlFilterObj[topLevelOp])[0];
    if (aggsField === field && !filterSelf) {
      // if `filterSelf` flag is false, do not filter the target field itself
      return null;
    }
    const value = graphqlFilterObj[topLevelOp][field];
    const numericOrTextType = getNumericTextType(esInstance, esIndex, esType, field);
    if (numericOrTextType === NumericTextTypeTypeEnum.ES_TEXT_TYPE) {
      resultFilterObj = getFilterItemForString(topLevelOp, field, value);
    } else if (numericOrTextType === NumericTextTypeTypeEnum.ES_NUMERIC_TYPE) {
      resultFilterObj = getFilterItemForNumbers(topLevelOp, field, value);
    } else {
      throw new Error(`Invalid es field type ${numericOrTextType}`);
    }
  }
  return resultFilterObj;
};

const getESSortBody = (graphqlSort) => {
  let sortBody;
  if (typeof graphqlSort !== 'undefined') {
    if (graphqlSort.length > 0) {
      sortBody = graphqlSort;
    } else {
      sortBody = Object.keys(graphqlSort).map(field => ({ [field]: graphqlSort[field] }));
    }
  }
  return sortBody;
};

const filterData = (
  { esInstance, esIndex, esType },
  {
    filter, fields = [], sort, offset = 0, size,
  },
) => {
  const queryBody = { from: offset };
  if (typeof filter !== 'undefined') {
    queryBody.query = getFilterObj(esInstance, esIndex, esType, filter);
  }
  queryBody.sort = getESSortBody(sort);
  if (typeof size !== 'undefined') {
    queryBody.size = size;
  }
  if (fields && fields.length > 0) {
    queryBody._source = fields;
  }
  const resultPromise = esInstance.query(esIndex, esType, queryBody);
  return resultPromise;
};

export const getDataUsingScroll = (
  { esInstance, esIndex, esType },
  { filter, fields, sort },
) => {
  const esFilterObj = filter ? getFilterObj(esInstance, esIndex, esType, filter) : undefined;
  return esInstance.scrollQuery(esIndex, esType, {
    filter: esFilterObj,
    fields,
    sort: getESSortBody(sort),
  });
};

export const getCount = async (esInstance, esIndex, esType, filter) => {
  const result = await filterData({ esInstance, esIndex, esType }, { filter, fields: [] });
  return result.hits.total;
};

export const getData = async (
  {
    esInstance,
    esIndex,
    esType,
  }, {
    fields,
    filter,
    sort,
    offset = 0,
    size,
  }) => {
  if (typeof size !== 'undefined' && offset + size > SCROLL_PAGE_SIZE) {
    throw new Error(`Invalid large query for offset + size > ${SCROLL_PAGE_SIZE}, offset = ${offset} and size = ${size}`);
  }
  const result = await filterData(
    { esInstance, esIndex, esType },
    {
      filter, fields, sort, offset, size,
    },
  );
  return result.hits.hits.map(item => item._source);
};