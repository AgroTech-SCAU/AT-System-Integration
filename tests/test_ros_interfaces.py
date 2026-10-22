"""Offline interface authoring contracts; no ROS node or DDS discovery is started."""
import os
import sqlite3
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from agro_runtime.configuration import WorkspaceStore
from agro_runtime.errors import ContractValidationError
from agro_runtime.ros_interfaces import InterfaceLibrary, _identity


class OfflineInterfaces(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.store = WorkspaceStore(self.directory.name)
        self.library = InterfaceLibrary(self.store)
        self.no_ros = patch('agro_runtime.ros_interfaces.installed_schema',side_effect=ImportError)
        self.no_ros.start()

    def tearDown(self):
        self.no_ros.stop()
        self.store.db.close()
        self.directory.cleanup()

    def test_import_message_service_action_and_nested_defaults_offline(self):
        result = self.library.import_files('robot_interfaces',[
            {'name':'Point.msg','content':'float64 x 1.5\nfloat64 y\nstring label "a#b"'},
            {'name':'Move.srv','content':'Point target\nfloat64[2] speeds [1.0, 2.0]\n---\nbool success false\nstring message'},
            {'name':'MoveTo.action','content':'Point target\n---\nbool success\n---\nfloat32 progress'},
        ])
        self.assertEqual(len(result['types']),3)
        service = self.library.describe('service','robot_interfaces/srv/Move')
        self.assertEqual(service['fields']['target'],{'x':1.5,'y':0.0,'label':'a#b'})
        self.assertEqual(service['fields']['speeds'],[1.0,2.0])
        self.assertEqual(service['output_fields'],{'success':False,'message':''})
        action = self.library.describe('action','robot_interfaces/action/MoveTo')
        self.assertEqual(action['feedback_fields'],{'progress':0.0})
        self.assertEqual(action['source'],'imported')
        # Definitions survive a new library instance, without browser localStorage.
        self.assertEqual(InterfaceLibrary(self.store).describe('service','robot_interfaces/srv/Move'),service)

    def test_invalid_batch_never_writes_partial_definitions(self):
        for bad in [
            {'name':'../Escape.msg','content':'bool ready'},
            {'name':'Missing.msg','content':'Other value'},
            {'name':'Bad.srv','content':'bool request'},
            {'name':'Deep.msg','content':'Deep recursive'},
            {'name':'Big.msg','content':'float64[1000000] values'},
        ]:
            with self.subTest(bad=bad), self.assertRaises(ContractValidationError):
                self.library.import_files('robot_interfaces',[{'name':'Valid.msg','content':'bool ok'},bad])
            self.assertEqual(self.library.saved(),[])

    def test_boolean_words_in_strings_are_preserved(self):
        self.library.import_files('my_robot',[{'name':'Labels.msg','content':
            'string quoted "true"\nstring word false\nstring[] labels ["true", "false"]\n'
            'bool enabled true\nbool[] flags [true, false]'}])
        fields = self.library.describe('publish_once','my_robot/msg/Labels')['fields']
        self.assertEqual(fields,{'quoted':'true','word':'false','labels':['true','false'],
                                 'enabled':True,'flags':[True,False]})

    def test_default_types_ranges_and_lengths_are_validated(self):
        invalid = ['uint8 count -1','uint8 count 256','int8 count 128','uint64 count 18446744073709551616',
                   'bool enabled "yes"','bool enabled 1','float64 value 1e309','float32 value 1e39',
                   'float64[2] values [1.0]','uint8[] values [1, -1]','bool[] values [true, "false"]',
                   'string<=2 label "long"','uint8[<=2] values [1, 2, 3]']
        for content in invalid:
            with self.subTest(content=content), self.assertRaises(ContractValidationError):
                self.library.import_files('my_robot',[{'name':'Invalid.msg','content':content}])
            self.assertEqual(self.library.saved(),[])
        with self.assertRaises(ContractValidationError):
            self.library.import_files('my_robot',[
                {'name':'Count.msg','content':'uint8 count'},
                {'name':'Nested.msg','content':"Count value {'count': -1}"},
            ])
        self.assertEqual(self.library.saved(),[])

    def test_storage_failure_rolls_back_the_entire_import_batch(self):
        self.library.import_files('my_robot',[{'name':'First.msg','content':'bool original'}])
        previous = self.library.saved()
        second = _identity('my_robot/msg/Second')
        self.store.db.execute("CREATE TRIGGER fail_second BEFORE INSERT ON documents "
                              "WHEN NEW.kind='ros_schema' AND NEW.id='"+second+"' "
                              "BEGIN SELECT RAISE(ABORT,'simulated write failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.library.import_files('my_robot',[
                {'name':'First.msg','content':'bool replacement'},
                {'name':'Second.msg','content':'bool other'},
            ])
        self.assertEqual(self.library.saved(),previous)

    def test_catalog_reads_local_index_and_retains_imported_types(self):
        index = Path(self.directory.name)/'share/ament_index/resource_index/rosidl_interfaces'
        index.mkdir(parents=True)
        (index/'installed_robot').write_text('msg/State.idl\nsrv/Reset.srv\n../../etc/passwd\n')
        self.library.import_files('my_robot',[{'name':'Status.msg','content':'bool ready'}])
        with patch.dict(os.environ,{'AMENT_PREFIX_PATH':self.directory.name}):
            catalog = self.library.catalog()['types']
        self.assertEqual(catalog,[
            {'ros_type':'installed_robot/msg/State','source':'installed'},
            {'ros_type':'installed_robot/srv/Reset','source':'installed'},
            {'ros_type':'my_robot/msg/Status','source':'imported'},
        ])

    def test_installed_schema_is_cached_without_loading_rclpy(self):
        schema = {'fields':{'data':''},'field_types':{'data':'string'},'output_fields':{'data':''},'output_field_types':{'data':'string'}}
        with patch('agro_runtime.ros_interfaces.installed_schema',return_value=schema):
            self.assertEqual(self.library.describe('publish_once','std_msgs/msg/String')['source'],'installed')
        self.assertEqual(self.library.describe('subscribe_wait','std_msgs/msg/String')['source'],'cached')
        with self.assertRaises(ContractValidationError):
            self.library.describe('service','std_msgs/msg/String')


if __name__ == '__main__':
    unittest.main()
