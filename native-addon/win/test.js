try {
    const capture = require('./build/Release/capture.node');
    
    console.log('✅ Module loaded successfully');
    console.log('Test method:', capture.testMethod());
    
    const sources = capture.getAvailableSources();
    console.log('Found sources:', sources.length);
    
    if (sources.length > 0) {
        console.log('First source:', sources[0]);
    }
    
    console.log('✅ All tests passed');
    process.exit(0);
} catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
}