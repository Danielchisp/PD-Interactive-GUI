// Raw-data store OUTSIDE React state.
// React state only holds references (datasetId), metadata and indices.
// The column-by-column arrays live here and can be huge (200k+ rows).
//
// Shape of a dataset:
// {
//   id: string,
//   name: string,          // file name
//   columns: string[],     // column names in order
//   rowCount: number,
//   data: { [col]: Array }, // per-column data (columnar layout => fast for Plotly)
//   meta: { delimiter, headerRow, xColGuess }
// }

const store = new Map()

let seq = 0
export function nextDatasetId() {
  seq += 1
  return `ds_${Date.now().toString(36)}_${seq}`
}

export function putDataset(dataset) {
  store.set(dataset.id, dataset)
  return dataset.id
}

export function getDataset(id) {
  return store.get(id)
}

export function getColumn(datasetId, col) {
  const ds = store.get(datasetId)
  return ds ? ds.data[col] : undefined
}

export function deleteDataset(id) {
  store.delete(id)
}
