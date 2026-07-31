import h5py
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

FILE_PATH = r"D:\data\data\main2\master_2_filtrado.hdf5"

def inspect_all_measurements(file_path):
    with h5py.File(file_path, 'r') as f:
        test_key = list(f.keys())[0]
        test_group = f[test_key]
        print(f"Mediciones dentro de '{test_key}': {list(test_group.keys())}\n")
        
        for m_name in test_group.keys():
            m_obj = test_group[m_name]
            print(f"Medición: '{m_name}'")
            print(f"  • Atributos: {dict(m_obj.attrs)}")
            print(f"  • Contenido: {list(m_obj.keys())}")
            if 'data' in m_obj:
                print(f"  • shape de 'data': {m_obj['data'].shape}, dtype: {m_obj['data'].dtype}")

if __name__ == "__main__":
    inspect_all_measurements(FILE_PATH)
