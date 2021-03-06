/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import { ESFilter } from '../../../../../../../plugins/apm/typings/elasticsearch';
import { UIFilters } from '../../../../typings/ui-filters';
import { getEnvironmentUiFilterES } from './get_environment_ui_filter_es';
import {
  localUIFilters,
  localUIFilterNames
} from '../../ui_filters/local_ui_filters/config';
import {
  esKuery,
  IIndexPattern
} from '../../../../../../../../src/plugins/data/server';

export function getUiFiltersES(
  indexPattern: IIndexPattern | undefined,
  uiFilters: UIFilters
) {
  const { kuery, environment, ...localFilterValues } = uiFilters;
  const mappedFilters = localUIFilterNames
    .filter(name => name in localFilterValues)
    .map(filterName => {
      const field = localUIFilters[filterName];
      const value = localFilterValues[filterName];
      return {
        terms: {
          [field.fieldName]: value
        }
      };
    }) as ESFilter[];

  // remove undefined items from list
  const esFilters = [
    getKueryUiFilterES(indexPattern, uiFilters.kuery),
    getEnvironmentUiFilterES(uiFilters.environment)
  ]
    .filter(filter => !!filter)
    .concat(mappedFilters) as ESFilter[];

  return esFilters;
}

function getKueryUiFilterES(
  indexPattern: IIndexPattern | undefined,
  kuery?: string
) {
  if (!kuery || !indexPattern) {
    return;
  }

  const ast = esKuery.fromKueryExpression(kuery);
  return esKuery.toElasticsearchQuery(ast, indexPattern) as ESFilter;
}
